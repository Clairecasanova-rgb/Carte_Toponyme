/* ============================================================
   PWA UI — Toponymie Corse
   ============================================================
   Composants client injectes dans chaque carte HTML :
   - Badge online/offline (haut-droite)
   - Modal "Preparer pour hors-ligne" (pre-cache de tuiles)
   - Modal "Gerer le cache" (stats + vider)
   - Queue IndexedDB pour les editions offline + sync auto au retour
   ============================================================ */

(function() {
    'use strict';
    if (window._pwaUiLoaded) return;
    window._pwaUiLoaded = true;

    var DB_NAME = 'topo-sync';
    var DB_VERSION = 4;
    var STORE = 'queue';
    var BATCH_STORE = 'precacheBatches';  // 1 entree par pre-cache lance par l'utilisateur
    var TRACK_STORE = 'tracks';           // 1 entree par parcours de marche enregistre
    var VS_STORE = 'viewsheds';           // 1 entree par champ de visibilite sauvegarde

    // ===== Patch Leaflet : zoom au-dela du max n'efface plus le calque =====
    // Par defaut, quand on zoome au-dela du maxZoom d'une couche, Leaflet la
    // fait disparaitre. On preferere garder les tuiles upscalees (floues mais
    // visibles) pour le reperage offline. On force donc maxNativeZoom = ancien
    // maxZoom (= dernier zoom ou les tuiles existent reellement) et on bump
    // maxZoom a 22 (limite Leaflet). Idem pour minNativeZoom / minZoom.
    function _patchTileLayerOptions(layer) {
        if (!layer || !layer.options) return;
        var o = layer.options;
        // Zoom natif REEL du serveur de cette couche (au-dela, le serveur n'a
        // pas de tuile : certains -- OpenTopoMap -- renvoient un PNG "max zoom"
        // au lieu d'une erreur, donc ne JAMAIS demander au-dela). Capture une
        // seule fois, avant tout bump.
        if (o._pwaServerMax == null) {
            o._pwaServerMax = (o.maxNativeZoom != null) ? o.maxNativeZoom
                : (o.maxZoom != null ? o.maxZoom : 19);
        }
        // maxNativeZoom = max serveur reel : Leaflet AGRANDIT lui-meme au-dela
        // (flou mais propre, sans tuile placeholder serveur).
        o.maxNativeZoom = o._pwaServerMax;
        // minNativeZoom = 8 (zoom min du contexte Corse pre-cache) : au DEZOOM
        // sous 8, Leaflet REDUIT les tuiles z8 au lieu de demander z6/z7 non
        // caches -> pas de trou au dezoom non plus.
        o.minNativeZoom = 8;
        o.maxZoom = 22;
        o.minZoom = 0;
        _attachTileErrorFallback(layer);
    }

    // Fallback robuste INDEPENDANT des metadonnees : si une tuile echoue
    // HORS-LIGNE (zoom au-dela du cache, ex: contexte Corse z>10), on baisse
    // maxNativeZoom de cette couche au niveau qui echoue -1. Leaflet agrandit
    // alors la tuile cachee la plus profonde -> flou mais JAMAIS de trou.
    // Converge tout seul vers le zoom reellement cache, par couche, sans
    // savoir ce qui a ete telecharge.
    function _attachTileErrorFallback(layer) {
        if (!layer || layer.__pwaTileErrHook) return;
        layer.__pwaTileErrHook = true;
        layer.on('tileerror', function(e) {
            try {
                var offline = (typeof isAppOffline === 'function') ? isAppOffline() : !navigator.onLine;
                if (!offline) return;
                var z = (e && e.coords && typeof e.coords.z === 'number')
                    ? e.coords.z
                    : (layer._map ? layer._map.getZoom() : null);
                if (z == null) return;
                var cur = (layer.options.maxNativeZoom != null) ? layer.options.maxNativeZoom : 21;
                var target = Math.max(8, Math.min(cur, z) - 1);
                if (target < cur) {
                    layer.options.maxNativeZoom = target;
                    if (layer._map) { try { layer.redraw(); } catch(_e) {} }
                }
            } catch(_e) {}
        });
    }
    if (typeof L !== 'undefined' && L.TileLayer && L.TileLayer.prototype) {
        var _origTLOnAdd = L.TileLayer.prototype.onAdd;
        L.TileLayer.prototype.onAdd = function(map) {
            _patchTileLayerOptions(this);
            // Egalement bump la map elle-meme pour autoriser le zoom au-dela
            if (map && map.options) {
                if (map.options.maxZoom == null || map.options.maxZoom < 22) map.options.maxZoom = 22;
                if (map.options.minZoom == null || map.options.minZoom > 0) map.options.minZoom = 0;
            }
            return _origTLOnAdd.call(this, map);
        };
    }
    // Patcher aussi les layers deja attaches a la map au moment du chargement.
    function _patchExistingTileLayers() {
        if (typeof L === 'undefined') return;
        try {
            var map = (typeof findLeafletMap === 'function') ? findLeafletMap() : null;
            if (!map) return;
            if (map.options) {
                if (map.options.maxZoom == null || map.options.maxZoom < 22) map.options.maxZoom = 22;
                if (map.options.minZoom == null || map.options.minZoom > 0) map.options.minZoom = 0;
            }
            map.eachLayer(function(l) {
                if (l instanceof L.TileLayer) _patchTileLayerOptions(l);
            });
        } catch(_e) {}
    }

    // ===== maxNativeZoom adaptatif (anti-disparition hors-ligne) =====
    // Zoom max REELLEMENT telecharge : contexte Corse leger=10 / complet=14,
    // ou zmax des zones/communes pre-cachees. HORS-LIGNE on cale
    // maxNativeZoom dessus -> Leaflet AGRANDIT lui-meme au-dela (flou mais
    // present, sans dependre du SW ni de tuiles lisibles). EN LIGNE on garde
    // un maxNativeZoom haut (detail reseau complet).
    function _computeMaxCachedZoom() {
        return dbBatchAll().then(function(batches) {
            var mx = 0;
            (batches || []).forEach(function(b) {
                if (b.kind !== 'context' && b.zmax) mx = Math.max(mx, b.zmax);
            });
            var lvl = (typeof _getCorseContextLevel === 'function') ? _getCorseContextLevel() : '';
            if (lvl === 'full') mx = Math.max(mx, 14);
            else if (lvl === 'light') mx = Math.max(mx, 10);
            try {
                var z = getStoredZone();
                if (z && z.zmax) mx = Math.max(mx, z.zmax);
            } catch(_e) {}
            return mx || null;
        }).catch(function() { return null; });
    }
    // Zoom max reellement cache (indice metadonnees), maj par
    // _applyAdaptiveNativeZoom. Sert a RE-ARMER maxNativeZoom avant chaque
    // changement de vue : ainsi une zone detaillee re-tente son zoom natif
    // (net) au lieu de rester bloquee sur le cap baisse par 'tileerror'
    // dans une zone contexte-seul.
    var _maxCachedHint = null;
    function _setupNativeZoomReprobe(attempt) {
        attempt = attempt || 0;
        var map = (typeof findLeafletMap === 'function') ? findLeafletMap() : null;
        if (!map) {
            if (attempt < 15) setTimeout(function() { _setupNativeZoomReprobe(attempt + 1); }, 700);
            return;
        }
        if (map.__pwaReprobe) return;
        map.__pwaReprobe = true;
        function rearm() {
            var offline = (typeof isAppOffline === 'function') ? isAppOffline() : !navigator.onLine;
            if (!offline) return;
            var ceil = _maxCachedHint || 21;
            map.eachLayer(function(l) {
                if (!(l instanceof L.TileLayer)) return;
                // Ne jamais depasser le max serveur reel de la couche.
                var sMax = (l.options._pwaServerMax != null) ? l.options._pwaServerMax : 21;
                var c = Math.min(ceil, sMax);
                if (l.options.maxNativeZoom !== c) {
                    // Pas de redraw : le move/zoom en cours va re-demander les
                    // tuiles avec cette nouvelle valeur. 'tileerror' rabaissera
                    // uniquement la ou le cache est moins profond.
                    l.options.maxNativeZoom = c;
                }
            });
        }
        map.on('zoomstart', rearm);
        map.on('movestart', rearm);
    }

    function _applyAdaptiveNativeZoom() {
        if (typeof L === 'undefined') return;
        var map = (typeof findLeafletMap === 'function') ? findLeafletMap() : null;
        if (!map) return;
        var offline = (typeof isAppOffline === 'function') ? isAppOffline() : !navigator.onLine;
        _computeMaxCachedZoom().then(function(maxCached) {
            _maxCachedHint = maxCached || null;  // memorise pour le re-armement
            map.eachLayer(function(l) {
                if (!(l instanceof L.TileLayer)) return;
                var sMax = (l.options._pwaServerMax != null) ? l.options._pwaServerMax : 21;
                if (offline && maxCached) {
                    // Hors-ligne avec indice : cap au zoom cache (sans depasser
                    // le max serveur) -> upscale CSS
                    var capO = Math.min(maxCached, sMax);
                    if (l.options.maxNativeZoom !== capO) {
                        l.options.maxNativeZoom = capO;
                        if (l._map) try { l.redraw(); } catch(_e) {}
                    }
                } else if (offline) {
                    // Hors-ligne SANS metadonnees : on ne force PAS un cap haut
                    // (ferait clignoter des trous). Le hook 'tileerror'
                    // (_attachTileErrorFallback) baissera tout seul au besoin.
                } else {
                    // En ligne : cap au max serveur reel de la couche. Au-dela,
                    // Leaflet agrandit la derniere tuile nette (flou mais propre)
                    // -> pas de tuile placeholder "max zoom" du serveur.
                    if (l.options.maxNativeZoom !== sMax) {
                        l.options.maxNativeZoom = sMax;
                        if (l._map) try { l.redraw(); } catch(_e) {}
                    }
                }
            });
        });
    }

    // ===== Mode test hors-ligne simule =====
    // Permet de declencher le comportement offline (queue, marker orange, etc.)
    // sans avoir a couper la 4G. Stocke dans sessionStorage pour survivre aux
    // rechargements de page du test, mais reset a la fermeture de l'onglet.
    function isForcedOffline() {
        try { return sessionStorage.getItem('pwaForceOffline') === '1'; }
        catch(_e) { return false; }
    }
    function setForcedOffline(v) {
        try {
            if (v) sessionStorage.setItem('pwaForceOffline', '1');
            else sessionStorage.removeItem('pwaForceOffline');
        } catch(_e) {}
        // Informer le SW pour qu'il traite aussi comme offline
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({
                type: 'SET_FORCE_OFFLINE', value: !!v
            });
        }
        // Re-caler maxNativeZoom (test offline = comme hors-ligne reel)
        try { if (typeof _applyAdaptiveNativeZoom === 'function') _applyAdaptiveNativeZoom(); } catch(_e) {}
    }
    // Etat composite : online seulement si navigator.onLine ET pas forced
    function isAppOffline() {
        return isForcedOffline() || !navigator.onLine;
    }

    // ===== IndexedDB helpers =====
    function openDb() {
        return new Promise(function(resolve, reject) {
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function(e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
                }
                if (!db.objectStoreNames.contains(BATCH_STORE)) {
                    db.createObjectStore(BATCH_STORE, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(TRACK_STORE)) {
                    db.createObjectStore(TRACK_STORE, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(VS_STORE)) {
                    db.createObjectStore(VS_STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = function() { resolve(req.result); };
            req.onerror = function() { reject(req.error); };
        });
    }

    function dbAdd(item) {
        return openDb().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(STORE, 'readwrite');
                var req = tx.objectStore(STORE).add(item);
                req.onsuccess = function() { resolve(req.result); };
                req.onerror = function() { reject(req.error); };
            });
        });
    }

    function dbAll() {
        return openDb().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(STORE, 'readonly');
                var req = tx.objectStore(STORE).getAll();
                req.onsuccess = function() { resolve(req.result || []); };
                req.onerror = function() { reject(req.error); };
            });
        });
    }

    function dbDel(id) {
        return openDb().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(STORE, 'readwrite');
                var req = tx.objectStore(STORE).delete(id);
                req.onsuccess = function() { resolve(); };
                req.onerror = function() { reject(req.error); };
            });
        });
    }

    // ===== Batches de pre-cache (1 par DL lance par l'utilisateur) =====
    // {id, label, kind, date, zmin, zmax, count, urls:[...], contextCache?}
    // urls : liste des URLs tuiles -> permet une suppression selective sans
    // toucher aux tuiles partagees par un autre batch conserve.
    function dbBatchPut(batch) {
        return openDb().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(BATCH_STORE, 'readwrite');
                var req = tx.objectStore(BATCH_STORE).put(batch);
                req.onsuccess = function() { resolve(); };
                req.onerror = function() { reject(req.error); };
            });
        });
    }
    function dbBatchAll() {
        return openDb().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(BATCH_STORE, 'readonly');
                var req = tx.objectStore(BATCH_STORE).getAll();
                req.onsuccess = function() { resolve(req.result || []); };
                req.onerror = function() { reject(req.error); };
            });
        }).catch(function() { return []; });
    }
    function dbBatchDel(id) {
        return openDb().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(BATCH_STORE, 'readwrite');
                var req = tx.objectStore(BATCH_STORE).delete(id);
                req.onsuccess = function() { resolve(); };
                req.onerror = function() { reject(req.error); };
            });
        });
    }

    // ===== Parcours de marche (tracks) — store IndexedDB dedie =====
    function dbTrackPut(track) {
        return openDb().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(TRACK_STORE, 'readwrite');
                var req = tx.objectStore(TRACK_STORE).put(track);
                req.onsuccess = function() { resolve(); };
                req.onerror = function() { reject(req.error); };
            });
        });
    }
    function dbTrackAll() {
        return openDb().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(TRACK_STORE, 'readonly');
                var req = tx.objectStore(TRACK_STORE).getAll();
                req.onsuccess = function() { resolve(req.result || []); };
                req.onerror = function() { reject(req.error); };
            });
        }).catch(function() { return []; });
    }
    function dbTrackGet(id) {
        return openDb().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(TRACK_STORE, 'readonly');
                var req = tx.objectStore(TRACK_STORE).get(id);
                req.onsuccess = function() { resolve(req.result || null); };
                req.onerror = function() { reject(req.error); };
            });
        }).catch(function() { return null; });
    }
    function dbTrackDel(id) {
        return openDb().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(TRACK_STORE, 'readwrite');
                var req = tx.objectStore(TRACK_STORE).delete(id);
                req.onsuccess = function() { resolve(); };
                req.onerror = function() { reject(req.error); };
            });
        });
    }

    // ===== Sync queue : wrapper fetch =====
    // Intercepte les fetch vers Supabase REST + Storage et, si offline ou si
    // l'appel echoue, met l'operation en queue pour replay au retour reseau.
    // Le body peut etre une string (JSON REST), un FormData (upload Storage)
    // ou un Blob -- on les serialise au mieux pour IndexedDB.
    var _origFetch = window.fetch.bind(window);

    // Extrait le Blob image d'un body d'upload Storage (Blob/File direct, ou
    // 1re entree Blob d'un FormData). Sert a cacher la photo hors-ligne.
    function _extractImageBlob(body) {
        try {
            if (!body) return null;
            if (typeof Blob !== 'undefined' && body instanceof Blob) return body;
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                var it = body.entries();
                for (var p = it.next(); !p.done; p = it.next()) {
                    if (p.value[1] instanceof Blob) return p.value[1];
                }
            }
        } catch(_e) {}
        return null;
    }

    async function serializeBody(body) {
        if (!body) return { type: 'null', value: null };
        if (typeof body === 'string') return { type: 'string', value: body };
        if (body instanceof Blob) {
            return { type: 'blob', value: body, mime: body.type };
        }
        if (typeof FormData !== 'undefined' && body instanceof FormData) {
            // Serialise FormData en tableau d'entries (blobs inclus)
            var entries = [];
            var iter = body.entries();
            for (var pair = iter.next(); !pair.done; pair = iter.next()) {
                var key = pair.value[0], val = pair.value[1];
                if (val instanceof Blob) {
                    entries.push({ key: key, kind: 'blob', value: val,
                        filename: val.name || 'file', mime: val.type });
                } else {
                    entries.push({ key: key, kind: 'string', value: String(val) });
                }
            }
            return { type: 'formdata', value: entries };
        }
        // ArrayBuffer / URLSearchParams / autre : fallback string
        try { return { type: 'string', value: String(body) }; }
        catch(e) { return { type: 'null', value: null }; }
    }

    function deserializeBody(s) {
        if (!s || s.type === 'null') return null;
        if (s.type === 'string') return s.value;
        if (s.type === 'blob') return s.value;
        if (s.type === 'formdata') {
            var fd = new FormData();
            (s.value || []).forEach(function(e) {
                if (e.kind === 'blob') {
                    fd.append(e.key, e.value, e.filename);
                } else {
                    fd.append(e.key, e.value);
                }
            });
            return fd;
        }
        return null;
    }

    window.fetch = function(input, init) {
        init = init || {};
        var url = typeof input === 'string' ? input : (input.url || '');
        var method = (init.method || 'GET').toUpperCase();
        // Intercepter : REST mutations + Storage uploads (PUT/POST)
        var isRestMut = /supabase\.co\/rest\/v1\//.test(url) &&
                        (method === 'POST' || method === 'PATCH' || method === 'DELETE');
        var isStorageMut = /supabase\.co\/storage\/v1\//.test(url) &&
                           (method === 'POST' || method === 'PUT' || method === 'DELETE');
        if (!isRestMut && !isStorageMut) return _origFetch(input, init);

        // Si mode test hors-ligne force, simuler un echec reseau direct
        // (ne PAS lancer le fetch reel, eviter de spammer Supabase)
        var attempt;
        if (isForcedOffline()) {
            attempt = Promise.reject(new Error('forced-offline'));
        } else {
            attempt = _origFetch(input, init);
        }
        return attempt.catch(async function(err) {
            console.warn('[PWA Sync] Echec reseau, mise en queue :', method, url);
            // Identifiant lisible (nom du point pour REST, nom de fichier pour Storage)
            var summary = '';
            var parsedBody = null;
            try {
                if (isStorageMut) {
                    var fileMatch = /\/object\/[^\/]+\/(.+)$/.exec(url);
                    summary = fileMatch ? '[Photo] ' + decodeURIComponent(fileMatch[1]) : '[Photo]';
                } else if (init.body && typeof init.body === 'string') {
                    parsedBody = JSON.parse(init.body);
                    summary = parsedBody.name || parsedBody.nom || '';
                }
            } catch(e) {}

            // === Affichage immediat du point offline sur la carte ===
            // Pour les POST custom_features avec geometry Point, on cree un marker
            // visible (orange + badge "en attente") meme avant le sync Supabase.
            // L'utilisateur sait ainsi que son point a ete pris en compte.
            if (method === 'POST' && /\/rest\/v1\/custom_features\b/.test(url) && parsedBody && parsedBody.geometry) {
                try { addOfflineFeatureToMap(parsedBody); }
                catch(e) { console.warn('[PWA] Affichage offline echoue :', e); }
            }
            var bodySer = await serializeBody(init.body);

            // Normaliser headers : Headers object n'est PAS clonable par IndexedDB.
            // On le convertit en plain object pour eviter DataCloneError silencieux.
            var headersPlain = {};
            try {
                if (init.headers) {
                    if (typeof Headers !== 'undefined' && init.headers instanceof Headers) {
                        init.headers.forEach(function(v, k) { headersPlain[k] = v; });
                    } else if (Array.isArray(init.headers)) {
                        init.headers.forEach(function(pair) { headersPlain[pair[0]] = pair[1]; });
                    } else if (typeof init.headers === 'object') {
                        Object.keys(init.headers).forEach(function(k) {
                            var v = init.headers[k];
                            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                                headersPlain[k] = String(v);
                            }
                        });
                    }
                }
            } catch(e) {
                console.warn('[PWA Sync] Normalisation headers :', e);
            }

            return dbAdd({
                url: url,
                method: method,
                headers: headersPlain,
                bodySer: bodySer,
                summary: summary,
                kind: isStorageMut ? 'storage' : 'rest',
                createdAt: Date.now(),
                attempts: 0
            }).then(function(insertedId) {
                console.log('[PWA Sync] Queue OK (id=' + insertedId + ') :', method, url.split('?')[0], 'summary=' + (summary || '(vide)'));
                updateQueueBadge();
                ensureQueuePolling();
                // Toast utilisateur : confirme visuellement que le point a ete mis en queue
                try {
                    if (method === 'POST' && /\/rest\/v1\/custom_features\b/.test(url)) {
                        showToast('Point en attente : ' + (summary || 'enregistre offline'), 3000);
                    } else if (isStorageMut && method === 'POST') {
                        showToast('Photo en attente de sync', 2500);
                    }
                } catch(_e) {}
                if ('serviceWorker' in navigator && 'SyncManager' in window) {
                    navigator.serviceWorker.ready.then(function(reg) {
                        return reg.sync.register('sync-queue');
                    }).catch(function(e) {
                        console.warn('[PWA Sync] Background Sync non dispo :', e.message);
                    });
                }
                // Pour les uploads Storage : retourner une fausse reponse avec
                // l'URL publique attendue, pour que le code appelant continue.
                if (isStorageMut && method === 'POST') {
                    var pathMatch = /\/object\/([^\/]+)\/(.+)$/.exec(url);
                    var fakeUrl = pathMatch ? url.replace('/object/', '/object/public/') : url;
                    // Mettre le Blob photo en cache sous l'URL publique : apercu
                    // <img> fonctionnel hors-ligne avant meme la synchro.
                    try {
                        var _imgBlob = _extractImageBlob(init.body);
                        if (_imgBlob && navigator.serviceWorker && navigator.serviceWorker.controller) {
                            navigator.serviceWorker.controller.postMessage({
                                type: 'CACHE_PHOTO', url: fakeUrl,
                                blob: _imgBlob, mime: _imgBlob.type || 'image/jpeg'
                            });
                        }
                    } catch(_e) { console.warn('[PWA] Cache photo offline echoue :', _e); }
                    return new Response(JSON.stringify({ Key: pathMatch ? pathMatch[2] : '', queued: true, offline: true, publicUrl: fakeUrl }),
                        { status: 202, headers: { 'Content-Type': 'application/json' } });
                }
                return new Response(JSON.stringify({ queued: true, offline: true }),
                    { status: 202, headers: { 'Content-Type': 'application/json' } });
            }).catch(function(dbErr) {
                // CRITIQUE : si dbAdd echoue, le point est perdu apres reload !
                // On informe explicitement l'utilisateur pour qu'il sache que sa modif
                // n'est PAS persistee (et qu'il puisse re-essayer en ligne).
                console.error('[PWA Sync] dbAdd ECHOUE :', dbErr, '— item:', { method: method, url: url, summary: summary });
                try {
                    showToast('Erreur : impossible de mettre en queue (' + (dbErr && dbErr.name ? dbErr.name : 'erreur') + '). Reessaye en ligne.', 7000);
                } catch(_e) {}
                // Retourner une 503 pour que le code appelant sache qu'il y a eu un probleme
                return new Response(JSON.stringify({ error: 'queue-failed', message: String(dbErr) }),
                    { status: 503, headers: { 'Content-Type': 'application/json' } });
            });
        });
    };

    // ===== Replay queue au retour online =====
    // Trie les items par ordre chronologique pour que les photos (storage POST)
    // soient envoyees AVANT le feature REST qui les reference. Pas de remap
    // d'URL pour l'instant : si une photo n'a pas pu etre uploadee au moment
    // de la creation, elle est uploadee plus tard mais le feature aura quand
    // meme la URL publique attendue (l'objet n'existait pas pendant le offline,
    // mais l'URL Supabase Storage est deterministe si on connait le chemin).
    var _replaying = false;
    async function replayQueue() {
        if (_replaying || isAppOffline()) return;
        _replaying = true;
        try {
            var items = await dbAll();
            items.sort(function(a, b) {
                // Storage avant rest pour le meme timestamp (uploads photos en premier)
                if (Math.abs(a.createdAt - b.createdAt) < 500) {
                    if (a.kind === 'storage' && b.kind !== 'storage') return -1;
                    if (b.kind === 'storage' && a.kind !== 'storage') return 1;
                }
                return a.createdAt - b.createdAt;
            });
            console.log('[PWA Sync] Replay : ' + items.length + ' operation(s)');
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                try {
                    var body = deserializeBody(it.bodySer);
                    var resp = await _origFetch(it.url, {
                        method: it.method,
                        headers: it.headers,
                        body: body
                    });
                    if (resp.ok || resp.status === 201 || resp.status === 204) {
                        await dbDel(it.id);
                        console.log('[PWA Sync] OK :', it.method, it.url.split('?')[0]);
                    } else if (resp.status >= 500 || resp.status === 429) {
                        console.warn('[PWA Sync] Server error ' + resp.status + ', reessai plus tard');
                        break;
                    } else {
                        console.warn('[PWA Sync] Drop (status ' + resp.status + ') :', it.method, it.url);
                        await dbDel(it.id);
                    }
                } catch (e) {
                    console.warn('[PWA Sync] Replay echoue (network), arret :', e);
                    break;
                }
            }
        } finally {
            _replaying = false;
            updateQueueBadge();
            // Si la queue est vide ou partiellement videe, nettoyer les markers
            // offline + recharger les features (recupere les vrais ID Supabase)
            dbAll().then(function(remaining) {
                if (remaining.length === 0) {
                    clearOfflineLayer();
                    if (typeof window.loadCustomFeatures === 'function') {
                        setTimeout(function() { window.loadCustomFeatures(); }, 300);
                    }
                }
            });
        }
    }

    // ===== Badge online/offline + queue =====
    function ensureBadge() {
        var b = document.getElementById('pwaStatusBadge');
        if (b) return b;
        b = document.createElement('div');
        b.id = 'pwaStatusBadge';
        // Position bas-gauche pour eviter le coin haut-droit (encombre : couches,
        // raster, fullscreen) et la popup de precision du LocateControl GPS.
        b.style.cssText =
            'position:fixed !important;bottom:10px !important;left:10px !important;' +
            'z-index:100050 !important;' +
            'display:flex !important;align-items:center;gap:6px;padding:5px 10px;' +
            'border-radius:14px;font:600 11px/1 Segoe UI,sans-serif;' +
            'background:rgba(255,255,255,0.95);box-shadow:0 1px 4px rgba(0,0,0,0.18);' +
            'cursor:pointer;user-select:none;pointer-events:auto;';
        b.title = 'Cliquer pour gerer le mode hors-ligne';
        b.onclick = openOfflineMenu;
        // Append a l'element fullscreen si actif, sinon body
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(b);
        return b;
    }

    // Bouton flottant "Position" juste au-dessus du badge en ligne/hors-ligne.
    function _ensurePosBtn() {
        var b = document.getElementById('pwaPosBtn');
        if (b) return b;
        b = document.createElement('button');
        b.id = 'pwaPosBtn';
        b.type = 'button';
        b.title = 'Position : partage et parcours';
        b.style.cssText =
            'position:fixed !important;bottom:46px !important;left:10px !important;' +
            'z-index:100050 !important;display:flex !important;align-items:center;gap:6px;' +
            'padding:6px 11px;border:none;border-radius:14px;font:600 11px/1 Segoe UI,sans-serif;' +
            'background:rgba(255,255,255,0.95);color:#5a3a1a;box-shadow:0 1px 4px rgba(0,0,0,0.18);' +
            'cursor:pointer;user-select:none;pointer-events:auto !important;';
        if (!document.getElementById('pwaLivePulseStyle')) {
            var ps = document.createElement('style');
            ps.id = 'pwaLivePulseStyle';
            ps.textContent = '@keyframes pwaLivePulse{0%,100%{opacity:1}50%{opacity:.2}}';
            document.head.appendChild(ps);
        }
        b.innerHTML =
            '<span id="pwaPosDot" style="display:none;width:8px;height:8px;border-radius:50%;' +
            'background:#ff5252;pointer-events:none;flex:none;"></span>' +
            '<span id="pwaPosLbl" style="pointer-events:none;">Position</span>';
        // PAS de L.DomEvent.disableClickPropagation : il bloque le clic sur ce
        // petit bouton au-dessus de la carte (le badge marche sans, on s'aligne).
        b.onclick = function(e) { e.stopPropagation(); _togglePosMenu(); };
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(b);
        try { _liveUpdateIndicator(); } catch(_e) {}  // refleter l'etat live
        return b;
    }
    // Fenetre regroupant "Ma position" + "Parcours de marche",
    // ouverte depuis le bouton flottant Position.
    function _togglePosMenu() {
        var ex = document.getElementById('pwaPosPanel');
        if (ex) { ex.remove(); return; }
        var m = document.createElement('div');
        m.id = 'pwaPosPanel';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100060;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;' +
            'font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);
        // Meme palette (brun/creme/olive) mais ton DISCRET : fonds clairs,
        // texte brun, bordure fine — pas d'aplats satures.
        var sectionTitle = 'font:700 10px Segoe UI,sans-serif;text-transform:uppercase;letter-spacing:0.6px;color:#8b7355;margin:14px 0 6px 2px;border-bottom:1px solid #f0ebe3;padding-bottom:4px;';
        var btnDiscret = 'background:#f7f3ec;color:#5a3a1a;border:1px solid #e3dac8;padding:9px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI,sans-serif;text-align:left;width:100%;transition:background 0.15s;';
        var btnPrimary = btnDiscret;
        var btnSecondary = btnDiscret;
        // Live ON : teinte teal douce (etat actif) ; OFF : discret comme le reste
        var liveStyle = _liveOn
            ? 'background:#e6f4f0;color:#0e7a68;border:1px solid #bfe3da;padding:9px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI,sans-serif;text-align:left;width:100%;transition:background 0.15s;'
            : btnDiscret;
        m.innerHTML =
            '<div style="background:#fff;border-radius:10px;max-width:480px;width:100%;max-height:88vh;'
            + 'overflow-y:auto;padding:20px 22px;box-shadow:0 4px 24px rgba(0,0,0,0.3);">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
            '<h2 style="margin:0;font-size:17px;color:#5a3a1a;font-family:Segoe UI,sans-serif;">Itineraire &amp; position</h2>' +
            '<button id="pwaPPClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:#8b7355;line-height:1;padding:0 4px;">&times;</button>' +
            '</div>' +
            '<div style="' + sectionTitle + '">Ma position</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;">' +
            '<button id="pwaPosA" style="' + btnPrimary + '">Publier ma position sur la carte</button>' +
            '<button id="pwaPosB" style="' + btnSecondary + '">Envoyer ma position (lien)</button>' +
            '<button id="pwaPosC" style="' + liveStyle + '">'
            + (_liveOn ? 'Arreter le partage en direct' : 'Partager ma position en direct') + '</button>' +
            '</div>' +
            '<div style="' + sectionTitle + '">Parcours de marche</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;">' +
            '<button id="pwaPosTrk" style="' + btnPrimary + '">Enregistrer / consulter mes parcours</button>' +
            '</div>' +
            '<div style="' + sectionTitle + '">Analyse</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;">' +
            '<button id="pwaPosVS" style="' + btnSecondary + '">Champ de visibilite (MNT)</button>' +
            '</div>' +
            '</div>';
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(m);
            L.DomEvent.disableScrollPropagation(m);
        }
        function close() { m.remove(); }
        m.querySelector('#pwaPPClose').onclick = close;
        m.onclick = function(e) { if (e.target === m) close(); };
        m.querySelector('#pwaPosA').onclick = function() { close(); _shareMyPositionOnMap(); };
        m.querySelector('#pwaPosB').onclick = function() { close(); _shareMyPositionLink(); };
        m.querySelector('#pwaPosC').onclick = function() { close(); _liveToggle(); };
        m.querySelector('#pwaPosTrk').onclick = function() { close(); openTracksFeature(); };
        m.querySelector('#pwaPosVS').onclick = function() { close(); _vsManager(); };
    }

    // ============================================================
    //  Champ de visibilite (viewshed) "Pixscape-like" depuis un point :
    //  - planimetrique precis (par-echantillon + courbure terrestre)
    //  - secteur directionnel (azimut + ouverture)
    //  - vue tangentielle (panorama azimut x angle vertical, colore distance)
    //  - inter-visibilite : points proches projetes sur le panorama
    //  - sauvegarde de la vue liee au point
    //  Calcul cote navigateur via l'API altimetrie IGN (reseau requis).
    //  Approche web => approximation (resolution bornee par le budget API),
    //  pas un viewshed raster pixel-exact.
    // ============================================================
    var _vsLayer = null, _vsLast = null;
    var _vsShownLayers = {};  // id -> L.layerGroup (vues affichees simultanement)
    var VS_ALTI = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
    var VS_OVERPASS = ['https://overpass-api.de/api/interpreter',
                       'https://overpass.kumi.systems/api/interpreter'];
    var VS_R = 6371000, VS_K = 0.13;  // rayon terre + coeff refraction

    function _vsDest(lat, lon, distM, bearingDeg) {
        var br = bearingDeg * Math.PI / 180;
        var dLat = (distM * Math.cos(br)) / 111320;
        var dLon = (distM * Math.sin(br)) / (111320 * Math.cos(lat * Math.PI / 180));
        return [lat + dLat, lon + dLon];
    }
    function _vsBearing(lat, lon, lat2, lon2) {
        var dy = (lat2 - lat) * 111320;
        var dx = (lon2 - lon) * 111320 * Math.cos(lat * Math.PI / 180);
        var a = Math.atan2(dx, dy) * 180 / Math.PI;
        return (a + 360) % 360;
    }
    function _vsDist(lat, lon, lat2, lon2) {
        var dy = (lat2 - lat) * 111320;
        var dx = (lon2 - lon) * 111320 * Math.cos(lat * Math.PI / 180);
        return Math.sqrt(dx * dx + dy * dy);
    }
    function _vsCurv(d) { return (1 - VS_K) * d * d / (2 * VS_R); }  // chute (m)
    // Position du soleil (NOAA simplifie) -- azimut a partir du Nord, sens
    // horaire ; precision ~0.5 deg, suffisant pour caler une boussole.
    // alt < 0 = sous l'horizon (sera signale a l'utilisateur).
    // Calibrage par marche GPS : on echantillonne navigator.geolocation
    // jusqu'a ce que le deplacement atteigne ~15 m, on en deduit le cap.
    // Independant du magnetometre et du soleil ; precision ~5-15 deg
    // (limitee par la precision GPS, ~5 m en plein air).
    function _vsCalibrateByWalk(ov, onAligned) {
        var ph = document.createElement('div');
        ph.style.cssText = 'position:absolute;inset:46px 0 0 0;background:rgba(0,0,0,0.85);'
            + 'color:#fff;padding:18px;font:14px Segoe UI;z-index:5;display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:flex-start;'
            + 'gap:8px;overflow:auto;';
        ph.innerHTML = '<div style="font-weight:700;font-size:15px;">'
            + 'Estimation du cap par GPS</div>'
            + '<div id="pwaWalkMsg" style="text-align:center;max-width:340px;'
            + 'opacity:0.9;font-size:12px;">Tiens le téléphone comme en AR (camera '
            + 'vers l\'avant) et marche en ligne droite dans cette direction.</div>'
            + '<div style="font-size:42px;font-weight:700;color:#aef;margin-top:8px;" '
            + 'id="pwaWalkDist">0.0 m</div>'
            + '<div id="pwaWalkBar" style="width:80%;max-width:300px;height:6px;'
            + 'background:rgba(255,255,255,0.18);border-radius:3px;overflow:hidden;">'
            + '<div id="pwaWalkBarF" style="width:0%;height:100%;background:#4caf50;'
            + 'transition:width 0.3s;"></div></div>'
            + '<div id="pwaWalkLive" style="font-size:11px;opacity:0.75;">'
            + 'En attente du GPS…</div>'
            + '<button id="pwaWalkX" style="margin-top:16px;background:#f0ebe3;'
            + 'color:#5a3a1a;border:none;border-radius:6px;padding:8px 16px;'
            + 'cursor:pointer;font:600 12px Segoe UI;">Annuler</button>';
        ov.appendChild(ph);
        var first = null, watch = -1, done = false;
        var TARGET_M = 15;
        function stop(success, bearing) {
            done = true;
            if (watch !== -1) { try { navigator.geolocation.clearWatch(watch); } catch(_e){} }
            ph.remove();
            if (success) onAligned(bearing);
        }
        ph.querySelector('#pwaWalkX').onclick = function() { stop(false); };
        if (!navigator.geolocation) {
            ph.querySelector('#pwaWalkMsg').textContent = 'GPS indisponible sur cet appareil';
            return;
        }
        watch = navigator.geolocation.watchPosition(function(pos) {
            if (done) return;
            var c = pos.coords;
            var msg = ph.querySelector('#pwaWalkMsg');
            var live = ph.querySelector('#pwaWalkLive');
            // On attend une fix decemment precise pour fixer le point de depart
            if (!first) {
                if (c.accuracy != null && c.accuracy <= 25) {
                    first = { lat: c.latitude, lon: c.longitude };
                    msg.textContent = 'Marche tout droit dans la direction où tu pointes le téléphone.';
                } else {
                    live.textContent = 'Attente d\'un point precis (±'
                        + (c.accuracy != null ? Math.round(c.accuracy) : '?') + ' m)…';
                    return;
                }
            }
            var d = _vsDist(first.lat, first.lon, c.latitude, c.longitude);
            ph.querySelector('#pwaWalkDist').textContent = d.toFixed(1) + ' m';
            ph.querySelector('#pwaWalkBarF').style.width =
                Math.min(100, (d / TARGET_M) * 100).toFixed(0) + '%';
            var liveTxt = 'precision GPS ±' + Math.round(c.accuracy || 0) + ' m';
            if (d >= 3) {
                var br = _vsBearing(first.lat, first.lon, c.latitude, c.longitude);
                liveTxt += ' · cap estime ' + Math.round(br) + '°';
            }
            live.textContent = liveTxt;
            if (d >= TARGET_M) {
                stop(true, _vsBearing(first.lat, first.lon, c.latitude, c.longitude));
            }
        }, function(err) {
            ph.querySelector('#pwaWalkMsg').textContent = 'GPS erreur : '
                + (err && err.message ? err.message : err);
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 });
    }
    function _vsSunAzEl(date, lat, lon) {
        var rad = Math.PI / 180;
        var jd = date.getTime() / 86400000 + 2440587.5;
        var n = jd - 2451545.0;
        var L = ((280.460 + 0.9856474 * n) % 360 + 360) % 360;
        var g = (((357.528 + 0.9856003 * n) % 360 + 360) % 360) * rad;
        var lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
        var eps = (23.439 - 0.0000004 * n) * rad;
        var ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
        var dec = Math.asin(Math.sin(eps) * Math.sin(lam));
        var gmst_h = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
        var lst_deg = gmst_h * 15 + lon;
        var H = lst_deg * rad - ra;
        var phi = lat * rad;
        var x = -Math.cos(dec) * Math.sin(H);
        var y = Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H);
        var z = Math.sin(dec) * Math.sin(phi) + Math.cos(dec) * Math.cos(phi) * Math.cos(H);
        return {
            az: (Math.atan2(x, y) / rad + 360) % 360,
            alt: Math.atan2(z, Math.sqrt(x * x + y * y)) / rad
        };
    }

    function _vsDelay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    // Altimetrie IGN par lots. Robuste au throttling : l'API renvoie 429
    // (Too Many Requests) quand les requetes s'enchainent trop vite -> on
    // respecte Retry-After / backoff exponentiel + petit espacement entre
    // lots, sinon le calcul echouait silencieusement (rien ne s'affichait).
    function _vsFetchElev(pts, onProgress) {
        // POST par GROS lots (1500 pts) -> tres peu de requetes : evite la
        // saturation de la passerelle IGN (504) et le throttling (429) sur
        // grand rayon. Repli automatique en GET (lots de 180) si le POST
        // n'est pas accepte (status method/format ou blocage reseau/CORS).
        var out = [], i = 0, MAXTRY = 7, postOk = true;
        var CH_POST = 1500, CH_GET = 180;
        function lonsLats(slice) {
            return [slice.map(function(p) { return p[1].toFixed(6); }).join('|'),
                    slice.map(function(p) { return p[0].toFixed(6); }).join('|')];
        }
        function doFetch(slice, attempt) {
            var usePost = postOk, ll = lonsLats(slice), req;
            if (usePost) {
                // POST JSON : l'IGN exige des valeurs en CHAINE (lon/lat
                // delimites, zonly:'true'). Verifie OK via Playwright.
                req = fetch(VS_ALTI, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lon: ll[0], lat: ll[1],
                        resource: 'ign_rge_alti_wld', delimiter: '|', zonly: 'true' })
                });
            } else {
                req = fetch(VS_ALTI + '?lon=' + ll[0] + '&lat=' + ll[1]
                    + '&resource=ign_rge_alti_wld&delimiter=|&zonly=true');
            }
            return req.then(function(r) {
                if (r.ok) return r.json();
                // POST refuse (format/methode/charge/500) -> repli GET prouve.
                if (usePost && (r.status === 400 || r.status === 404 || r.status === 405
                        || r.status === 413 || r.status === 414 || r.status === 415
                        || r.status === 500 || r.status === 501)) {
                    var er = new Error('post-ko'); er.__switchGet = true; throw er;
                }
                // Passerelle saturee (429/502/503/504) : backoff + retry.
                if ((r.status === 429 || r.status >= 500) && attempt < MAXTRY) {
                    var ra = parseInt(r.headers.get('Retry-After'), 10);
                    var wait = (ra > 0 ? ra * 1000 : Math.min(15000, 800 * Math.pow(2, attempt)));
                    return _vsDelay(wait).then(function() { return doFetch(slice, attempt + 1); });
                }
                throw new Error('Altimetrie IGN HTTP ' + r.status
                    + (r.status === 429 ? ' (trop de requetes)'
                       : (r.status === 503 || r.status === 504)
                         ? ' (serveur IGN sature : reessayer ou reduire le rayon)' : ''));
            }).catch(function(e) {
                if (e && e.__switchGet) throw e;
                var net = /NetworkError|Failed to fetch|load failed|aborted/i.test(String(e && e.message));
                if (usePost && net) { var er2 = new Error('post-net'); er2.__switchGet = true; throw er2; }
                if (attempt < MAXTRY && net) {
                    return _vsDelay(Math.min(15000, 800 * Math.pow(2, attempt)))
                        .then(function() { return doFetch(slice, attempt + 1); });
                }
                throw e;
            });
        }
        function next() {
            if (i >= pts.length) return Promise.resolve(out);
            var ch = postOk ? CH_POST : CH_GET;
            var slice = pts.slice(i, i + ch);
            return doFetch(slice, 0).then(function(j) {
                var ev = (j && j.elevations) || [];
                // ALIGNEMENT STRICT : chaque lot doit fournir EXACTEMENT
                // slice.length altitudes. L'IGN peut en renvoyer moins/plus :
                // sans ce garde-fou, tout l'index se decale et les cibles
                // (points perso) recuperaient l'altitude d'un echantillon
                // lointain -> elles se retrouvaient "sur des cretes".
                for (var qi = 0; qi < slice.length; qi++) {
                    var z = ev[qi];
                    out.push((typeof z === 'number' && z > -1000) ? z : 0);
                }
                i += slice.length;
                if (onProgress) onProgress(Math.min(i, pts.length), pts.length);
                return (i < pts.length) ? _vsDelay(postOk ? 150 : 120).then(next) : out;
            }).catch(function(e) {
                if (e && e.__switchGet) { postOk = false; return next(); }  // re-decoupe en GET
                throw e;
            });
        }
        return next();
    }

    // Bandeau de progression FIXE pendant le calcul (remplace les toasts
    // ephemeres qui clignotaient a chaque lot d'altimetrie). Un seul element,
    // mis a jour sur place, retire en fin de calcul (succes ou echec).
    var _vsProgEl = null;
    function _vsProgShow(txt) {
        _vsProgHide();
        var d = document.createElement('div');
        d.id = 'pwaVSprog';
        d.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);'
            + 'z-index:100068;background:#5a3a1a;color:#fff;padding:9px 16px;'
            + 'border-radius:20px;font:600 13px Segoe UI,sans-serif;'
            + 'box-shadow:0 2px 10px rgba(0,0,0,0.35);pointer-events:none;white-space:nowrap;';
        d.textContent = txt;
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement
            || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(d);
        _vsProgEl = d;
    }
    function _vsProgSet(txt) {
        if (_vsProgEl && _vsProgEl.isConnected) _vsProgEl.textContent = txt;
        else _vsProgShow(txt);
    }
    function _vsProgHide() {
        if (_vsProgEl) { try { _vsProgEl.remove(); } catch(_e) {} _vsProgEl = null; }
        var ex = document.getElementById('pwaVSprog');
        if (ex) { try { ex.remove(); } catch(_e) {} }
    }
    // Rendu net (pas de lissage) de l'imageOverlay : le navigateur interpole
    // l'image en bilineaire quand Leaflet l'agrandit -> mailles/trous floutes
    // et "combles" visuellement. On force un rendu pixelise pour garder le
    // grain et les vrais trous fideles a tout zoom.
    function _vsInjectOverlayStyle() {
        if (document.getElementById('pwaVSoverlayCss')) return;
        var s = document.createElement('style');
        s.id = 'pwaVSoverlayCss';
        s.textContent = '.pwa-vs-overlay{image-rendering:pixelated;'
            + 'image-rendering:-moz-crisp-edges;image-rendering:crisp-edges;}';
        (document.head || document.documentElement).appendChild(s);
    }
    // Place une etiquette en evitant le chevauchement avec celles deja
    // posees (rects). Teste plusieurs positions autour du point ; si aucune
    // n'est libre, l'etiquette est masquee (le point/marqueur reste).
    function _vsPlaceLabel(ctx, rects, mx, my, text, font, fg, W, H) {
        ctx.font = font;
        var tw = ctx.measureText(text).width, th = 12, pad = 2, MG = 3;
        // Candidates classees du PLUS PRES du point au plus loin (l'etiquette
        // reste collee au point -> on ne le percoit plus "plus haut").
        var cands = [
            [mx + 7, my + 4], [mx - tw - 9, my + 4],
            [mx + 7, my - 5], [mx - tw - 9, my - 5],
            [mx - tw / 2, my + 13], [mx - tw / 2, my - 11],
            [mx + 7, my + 15], [mx - tw - 9, my + 15],
            [mx + 7, my - 16], [mx - tw - 9, my - 16],
            [mx - tw / 2, my + 24], [mx - tw / 2, my - 22]
        ];
        for (var i = 0; i < cands.length; i++) {
            var lx = Math.max(2, Math.min(W - tw - 4, cands[i][0]));
            var ly = Math.max(11, Math.min(H - 3, cands[i][1]));
            var r = { x1: lx - pad, y1: ly - th + 1, x2: lx + tw + pad, y2: ly + 3 };
            var hit = false;
            for (var k = 0; k < rects.length; k++) {
                var o = rects[k];
                if (!(r.x2 + MG < o.x1 || r.x1 - MG > o.x2
                      || r.y2 + MG < o.y1 || r.y1 - MG > o.y2)) { hit = true; break; }
            }
            if (hit) continue;
            rects.push(r);
            if (Math.abs((lx + tw / 2) - mx) > 14 || Math.abs(ly - my) > 14) {
                ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(mx, my);
                ctx.lineTo(mx < lx ? lx - 1 : lx + tw + 1, ly - 4); ctx.stroke();
            }
            ctx.fillStyle = 'rgba(255,255,255,0.84)';
            ctx.fillRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
            ctx.fillStyle = fg; ctx.fillText(text, lx, ly);
            return true;
        }
        return false;
    }
    // Tri par distance croissante : les points PROCHES sont etiquetes en
    // priorite ; les lointains perdent leur libelle si la zone est saturee.
    function _vsByDist(a, b) { return (a.dist || 0) - (b.dist || 0); }
    // Couleur d'un point selon sa distance (effet de profondeur, meme echelle
    // que les reliefs/curseur) : proche = teinte vive de la categorie,
    // loin = estompe/pale. La forme garde l'identite (cercle/triangle/losange).
    function _vsPtCol(kind, dist, R) {
        var t = Math.max(0, Math.min(1, (dist || 0) / (R || 1)));
        function mix(a, b) { return Math.round(a + (b - a) * t); }
        if (kind === 'peak')
            return 'rgb(' + mix(120, 172) + ',' + mix(70, 160) + ',' + mix(20, 150) + ')';
        if (kind === 'patri')
            return 'rgb(' + mix(214, 200) + ',' + mix(20, 165) + ',' + mix(120, 190) + ')';
        return 'rgb(' + mix(20, 150) + ',' + mix(150, 182) + ',' + mix(60, 172) + ')';
    }
    function _vsPtR(dist, R) {
        var t = Math.max(0, Math.min(1, (dist || 0) / (R || 1)));
        return 6.5 - 3 * t;   // proche ~6.5 px -> loin ~3.5 px
    }
    // Marqueur Patrimoine sur la carte 2D : losange (forme differente des
    // sommets qui sont des cercles), couleur rose.
    function _vsDiamondIcon(color) {
        return L.divIcon({
            className: 'pwa-vs-diamond',
            html: '<div style="width:11px;height:11px;background:' + color
                + ';border:2px solid #fff;transform:rotate(45deg);'
                + 'box-shadow:0 0 2px rgba(0,0,0,0.45);"></div>',
            iconSize: [17, 17], iconAnchor: [8, 8]
        });
    }

    // Vue CAMERA (realite augmentee legere) : flux camera arriere + cap
    // boussole + overlay approximatif des elements visibles (sommets,
    // patrimoine, points perso) + liste du secteur pointe. Calage indicatif
    // (boussole/FOV web imprecis) : sert a identifier, pas a viser au degre.
    function _vsCameraView(res, opts) {
        opts = opts || {};
        var items = [];
        (res.peaks || []).forEach(function(p) {
            if (p.visible) items.push({ name: p.name, bearing: p.bearing, ang: p.ang,
                dist: p.dist, kind: 'peak', elev: p.elev, lat: p.lat, lon: p.lon });
        });
        (res.patrimoine || []).forEach(function(p) {
            if (p.visible) items.push({ name: p.name, bearing: p.bearing, ang: p.ang,
                dist: p.dist, kind: 'patri', lat: p.lat, lon: p.lon });
        });
        (res.targets || []).forEach(function(t) {
            if (t.visible) items.push({ name: t.name, bearing: t.bearing, ang: t.ang,
                dist: t.dist, kind: 'cible', lat: t.lat, lon: t.lon });
        });
        var R = res.radiusM || 1;
        function dTxt(d) {
            return d >= 1000 ? (d / 1000).toFixed(d >= 10000 ? 0 : 1) + ' km'
                : Math.round(d) + ' m';
        }
        function card(az) {
            return ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(((az % 360) / 45)) % 8];
        }
        var ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:100085;background:#000;'
            + 'font-family:Segoe UI,sans-serif;overflow:hidden;';
        var video = document.createElement('video');
        video.setAttribute('playsinline', ''); video.muted = true; video.autoplay = true;
        video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'
            + 'object-fit:cover;background:#111;';
        var canvas = document.createElement('canvas');
        canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'
            + 'pointer-events:none;';
        var hud = document.createElement('div');
        hud.style.cssText = 'position:absolute;top:0;left:0;right:0;'
            + 'display:flex;align-items:center;gap:10px;padding:8px 12px;color:#fff;'
            + 'background:linear-gradient(rgba(0,0,0,0.55),rgba(0,0,0,0));font:600 14px Segoe UI;';
        hud.innerHTML = '<span id="pwaCamCap">Cap —</span>'
            + '<span id="pwaCamOff" style="font-weight:400;font-size:11px;opacity:0.9;'
            + 'display:none;background:rgba(255,255,255,0.15);padding:2px 6px;border-radius:4px;"></span>'
            + '<button id="pwaCamMin" title="Decaler -1deg" style="background:rgba(255,255,255,0.15);'
            + 'color:#fff;border:1px solid rgba(255,255,255,0.35);border-radius:6px;padding:4px 8px;'
            + 'cursor:pointer;font:600 12px Segoe UI;">−1°</button>'
            + '<button id="pwaCamPlus" title="Decaler +1deg" style="background:rgba(255,255,255,0.15);'
            + 'color:#fff;border:1px solid rgba(255,255,255,0.35);border-radius:6px;padding:4px 8px;'
            + 'cursor:pointer;font:600 12px Segoe UI;">+1°</button>'
            + '<span style="flex:1"></span>'
            + '<button id="pwaCamRelief" title="Superposer la silhouette du relief calcule" '
            + 'style="background:rgba(255,100,180,0.2);color:#fff;border:1px solid rgba(255,100,180,0.5);'
            + 'border-radius:6px;padding:6px 10px;cursor:pointer;font:600 12px Segoe UI;">Relief</button>'
            + '<button id="pwaCamAuto" title="Affiner automatiquement le cap en comparant la silhouette MNT aux contours du paysage reel (detection du sky/relief)" '
            + 'style="background:rgba(120,200,140,0.22);color:#fff;border:1px solid rgba(120,200,140,0.55);'
            + 'border-radius:6px;padding:6px 10px;cursor:pointer;font:600 12px Segoe UI;">Affiner</button>'
            + '<button id="pwaCamCal" style="background:rgba(255,255,255,0.18);color:#fff;'
            + 'border:1px solid rgba(255,255,255,0.4);border-radius:6px;padding:6px 10px;'
            + 'cursor:pointer;font:600 12px Segoe UI;">Calibrer</button>'
            + '<button id="pwaCamXR" title="Mode AR stabilise (Android Chrome)" '
            + 'style="display:none;background:#1e3a5f;color:#fff;border:1px solid #3a6ea5;'
            + 'border-radius:6px;padding:6px 10px;cursor:pointer;font:600 12px Segoe UI;">AR</button>'
            + '<button id="pwaCamList" style="background:rgba(255,255,255,0.18);color:#fff;'
            + 'border:1px solid rgba(255,255,255,0.4);border-radius:6px;padding:6px 10px;'
            + 'cursor:pointer;font:600 12px Segoe UI;">Liste</button>'
            + '<button id="pwaCamX" style="background:#f0ebe3;color:#5a3a1a;border:none;'
            + 'border-radius:6px;padding:6px 12px;cursor:pointer;font:600 12px Segoe UI;">Fermer</button>';
        var manual = document.createElement('div');
        manual.style.cssText = 'position:absolute;top:46px;left:0;right:0;display:none;'
            + 'padding:6px 12px;color:#fff;background:rgba(0,0,0,0.4);font:600 11px Segoe UI;';
        manual.innerHTML = 'Boussole indisponible — direction manuelle : '
            + '<span id="pwaCamMv">0</span>°<br>'
            + '<input type="range" id="pwaCamM" min="0" max="359" value="0" style="width:100%;">';
        var list = document.createElement('div');
        list.style.cssText = 'position:absolute;left:0;right:0;bottom:0;max-height:42vh;'
            + 'overflow-y:auto;background:rgba(0,0,0,0.62);color:#fff;padding:8px 10px;'
            + 'font:13px Segoe UI;display:none;';
        // Mini-carte : vraie carte Leaflet (tuiles OSM/OpenTopo) + perimetre
        // de visibilite + points visibles + overlay canvas pour FOV/Nord.
        var miniMap = document.createElement('div');
        miniMap.title = 'Tape un point que tu vois pour caler le cap dessus';
        miniMap.style.cssText = 'position:absolute;bottom:12px;left:12px;width:180px;'
            + 'height:180px;z-index:6;border-radius:14px;overflow:hidden;'
            + 'box-shadow:0 3px 12px rgba(0,0,0,0.6);'
            + 'border:2px solid rgba(255,255,255,0.55);';
        var miniLeafDiv = document.createElement('div');
        miniLeafDiv.style.cssText = 'position:absolute;inset:0;background:#202833;';
        var miniOverlay = document.createElement('canvas');
        miniOverlay.width = 360; miniOverlay.height = 360;
        miniOverlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'
            + 'pointer-events:none;';
        // Boutons +/- pour zoomer/dezoomer dans la mini-carte (le drag reste
        // bloque pour garder l'observateur au centre).
        var zoomCtrl = document.createElement('div');
        zoomCtrl.style.cssText = 'position:absolute;top:6px;right:6px;display:flex;'
            + 'flex-direction:column;gap:2px;z-index:7;';
        function makeZb(txt) {
            var b = document.createElement('button');
            b.textContent = txt;
            b.style.cssText = 'width:28px;height:28px;border:1px solid rgba(255,255,255,0.4);'
                + 'background:rgba(20,28,40,0.82);color:#fff;cursor:pointer;'
                + 'border-radius:5px;font:bold 18px system-ui,sans-serif;'
                + 'line-height:1;padding:0;display:flex;align-items:center;'
                + 'justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.5);';
            return b;
        }
        var zInBtn = makeZb('+');
        var zOutBtn = makeZb('−');
        zoomCtrl.appendChild(zInBtn);
        zoomCtrl.appendChild(zOutBtn);
        miniMap.appendChild(miniLeafDiv);
        miniMap.appendChild(miniOverlay);
        miniMap.appendChild(zoomCtrl);
        // Bandeau de calage par perspective (visible seulement en mode calage).
        // left:155px pour ne pas recouvrir la mini-carte (toujours visible).
        var calibPane = document.createElement('div');
        calibPane.style.cssText = 'position:absolute;left:155px;right:0;bottom:0;'
            + 'background:linear-gradient(rgba(0,0,0,0),rgba(168,58,138,0.88));'
            + 'color:#fff;padding:14px 16px 16px;font:13px Segoe UI;display:none;'
            + 'z-index:4;';
        ov.appendChild(video); ov.appendChild(canvas); ov.appendChild(hud);
        ov.appendChild(manual); ov.appendChild(list); ov.appendChild(calibPane);
        ov.appendChild(miniMap);
        var fe = document.fullscreenElement || document.webkitFullscreenElement;
        (fe && !fe.contains(document.body) ? fe : document.body).appendChild(ov);
        // Init Leaflet une fois le conteneur dans le DOM (sinon size=0)
        setTimeout(function() { if (!dead) initMiniMap(); }, 30);

        var rawHeading = 0, heading = 0, pitch = 0, haveHeading = false;
        var stream = null, raf = 0, dead = false;
        // Lissage du cap : moyenne mobile sur (cos, sin) pour gerer le saut
        // 359 -> 0 sans clignotement. SMOOTH ~ poids du nouvel echantillon
        // (0.12 = lag ~8 frames a 60 Hz, ~130 ms, confortable a l'oeil).
        var smX = null, smY = null, smPitch = null;
        var SMOOTH = 0.12, SMOOTH_PITCH = 0.18;
        function smoothHeading(h) {
            var r = h * Math.PI / 180;
            var nx = Math.cos(r), ny = Math.sin(r);
            if (smX == null) { smX = nx; smY = ny; }
            else { smX = smX * (1 - SMOOTH) + nx * SMOOTH;
                   smY = smY * (1 - SMOOTH) + ny * SMOOTH; }
            return (Math.atan2(smY, smX) * 180 / Math.PI + 360) % 360;
        }
        // Hysteresis sur le cap affiche : ne reaffiche le degre rond
        // que si l'ecart au precedent depasse 1.2 deg (sinon flicker).
        var lastShownCap = null;
        // Decalage de cap (calibrage) : appris quand l'utilisateur pointe un
        // element connu, persiste en localStorage pour la session suivante.
        var headingOffset = 0;
        try { headingOffset = parseFloat(localStorage.getItem('pwaCamHeadOff')) || 0; } catch(_e) {}
        function saveOff() {
            // En mode XR, ARCore part d'un yaw arbitraire : l'offset ne
            // s'applique qu'a cette session, on ne le persiste pas en
            // localStorage (ce serait du bruit pour la prochaine session).
            // En mode magneto, on sauvegarde -> calibration durable.
            if (typeof xrSession === 'undefined' || !xrSession) {
                try { localStorage.setItem('pwaCamHeadOff', String(headingOffset)); } catch(_e) {}
            }
            var oe = hud.querySelector('#pwaCamOff');
            if (oe) {
                if (Math.abs(headingOffset) < 0.5) { oe.style.display = 'none'; oe.textContent = ''; }
                else {
                    oe.style.display = 'inline-block';
                    oe.textContent = (headingOffset > 0 ? '+' : '') + headingOffset.toFixed(1) + '°';
                }
            }
        }
        function applyOffset() {
            heading = ((rawHeading + headingOffset) % 360 + 360) % 360;
        }
        var hfov = 63;                                   // champ camera arriere ~estime
        function sizeCanvas() {
            canvas.width = ov.clientWidth; canvas.height = ov.clientHeight;
        }
        sizeCanvas();
        // Icones SVG (Path2D) : units centrees sur (0,0), echelle ~20px.
        // Genere a partir de chemins SVG, plus reconnaissables et propres
        // que les triangles/losanges canvas. Scale = rr / 10 a l'utilisation.
        // Pin teardrop partage par toutes les categories. Centre bulbe : (0,-8)
        // rayon utile ~7. Le pictogramme blanc est dessine par-dessus.
        var PIN_PATH = new Path2D(
            'M 0 13 C 0 13 -10 -3 -10 -9 C -10 -14.5 -5.5 -17 0 -17 '
          + 'C 5.5 -17 10 -14.5 10 -9 C 10 -3 0 13 0 13 Z');
        var PIN_SHADOW = new Path2D();
        PIN_SHADOW.ellipse(0, 14, 6, 2, 0, 0, 2 * Math.PI);
        // Palette terre/sable
        // [topGradient, bottomGradient]
        var PIN_COLORS = {
            peak:    ['#d47540', '#8a4220'],   // brun sienne
            patri:   ['#eebd55', '#a07820'],   // ocre
            cible:   ['#6a83a0', '#2e4256']    // ardoise
        };
        // 9 pictogrammes : sommet + 7 patrimoine + cible.
        // Chaque entree : white = Path2D fill blanc, dark = Path2D fill couleur kind
        // (pour les ouvertures, meurtrieres, etc.)
        function P(d) { return new Path2D(d); }
        var PICTOS = {
            peak: {
                white: P('M -6 -2 L 0 -13 L 6 -2 Z'),
                dark:  P('M -1.6 -7 L 0 -13 L 1.6 -7 L 1.2 -6 L -1.2 -6 Z')
            },
            'patri-tour': {
                white: P('M -4 -3 L 4 -3 L 4 -1.5 L -4 -1.5 Z'
                    + ' M -3 -11 L 3 -11 L 3 -3 L -3 -3 Z'
                    + ' M -4 -12.5 L 4 -12.5 L 4 -10.9 L -4 -10.9 Z'
                    + ' M -3.6 -14 L -2 -14 L -2 -12.5 L -3.6 -12.5 Z'
                    + ' M -0.8 -14 L 0.8 -14 L 0.8 -12.5 L -0.8 -12.5 Z'
                    + ' M 2 -14 L 3.6 -14 L 3.6 -12.5 L 2 -12.5 Z'),
                dark:  P('M -0.6 -7 L 0.6 -7 L 0.6 -5 L -0.6 -5 Z')
            },
            'patri-chapelle': {
                white: P('M -5.5 -7 L 5.5 -7 L 5.5 -0.5 L -5.5 -0.5 Z'
                    + ' M -5.5 -7 L 0 -11 L 5.5 -7 Z'
                    + ' M -0.7 -15 L 0.7 -15 L 0.7 -10.5 L -0.7 -10.5 Z'
                    + ' M -2 -13.5 L 2 -13.5 L 2 -12.1 L -2 -12.1 Z')
            },
            'patri-fort': {
                white: P('M -6 -1 L -6 -8 L -4.5 -8 L -4.5 -10 L -2.5 -10 '
                    + 'L -2.5 -8 L -1 -8 L -1 -12 L 1 -12 L 1 -8 L 2.5 -8 '
                    + 'L 2.5 -10 L 4.5 -10 L 4.5 -8 L 6 -8 L 6 -1 Z'),
                dark:  P('M -0.9 -4 L 0.9 -4 L 0.9 -1 L -0.9 -1 Z')
            },
            'patri-mega': {
                white: P('M -6.5 -2 L 6.5 -2 L 6.5 -0.5 L -6.5 -0.5 Z'
                    + ' M -5 -9 L -2 -9 L -2 -2 L -5 -2 Z'
                    + ' M 2 -9 L 5 -9 L 5 -2 L 2 -2 Z'
                    + ' M -6.5 -9 L 6.5 -11 L 6.5 -9 L -6.5 -7 Z')
            },
            'patri-grotte': {
                white: P('M -7 -1 Q -7 -14 0 -14 Q 7 -14 7 -1 Z'),
                dark:  P('M -3.5 -1 Q -3.5 -10 0 -10 Q 3.5 -10 3.5 -1 Z')
            },
            'patri-antique': {
                white: P('M -6 -11 L 0 -14 L 6 -11 Z'
                    + ' M -6 -11 L 6 -11 L 6 -9.5 L -6 -9.5 Z'
                    + ' M -5 -9.5 L -3.4 -9.5 L -3.4 -1.5 L -5 -1.5 Z'
                    + ' M -0.8 -9.5 L 0.8 -9.5 L 0.8 -1.5 L -0.8 -1.5 Z'
                    + ' M 3.4 -9.5 L 5 -9.5 L 5 -1.5 L 3.4 -1.5 Z'
                    + ' M -6 -1.5 L 6 -1.5 L 6 -0.1 L -6 -0.1 Z')
            },
            'patri-fouille': {
                // Cas special : dessine avec une rotation -30deg dans drawIcon.
                rotated: true,
                white: P('M -1.6 -14 L 1.6 -14 L 1.6 -12.6 L -1.6 -12.6 Z'
                    + ' M -0.7 -12.6 L 0.7 -12.6 L 0.7 -6.6 L -0.7 -6.6 Z'
                    + ' M -3.2 -6.5 L 3.2 -6.5 L 0 -1 Z')
            },
            cible: {
                white: P('M 0 -4 A 4 4 0 1 1 0 -12 A 4 4 0 1 1 0 -4 Z'),
                dark:  P('M 0 -6.3 A 1.7 1.7 0 1 1 0 -9.7 A 1.7 1.7 0 1 1 0 -6.3 Z')
            }
        };
        // Detection de la sous-categorie patrimoine depuis le nom de l'element.
        // Ordre important : la PREMIERE regle qui matche gagne.
        // Insensible casse + accents (NFD strip).
        function _patriIconKind(nom) {
            if (!nom) return 'patri-fouille';
            var n = String(nom).toLowerCase();
            try { n = n.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch(_e) {}
            if (/\b(stantar|menhir|dolmen|alignement|filitosa|cauria|petra pinzuta)/.test(n)) return 'patri-mega';
            if (/\b(grotte|balma|abri[- ]sous[- ]roche|abri rocheux)/.test(n)) return 'patri-grotte';
            if (/\b(tour|torra|torre|vedetta)\b/.test(n)) return 'patri-tour';
            if (/\b(castel|castello|castellu|castiglio|fort|fortin|citadelle)/.test(n)) return 'patri-fort';
            if (/\b(romain|antique|aleria|mariana|paleo)/.test(n)) return 'patri-antique';
            if (/\b(chiesa|ghjesgia|eglise|chapelle|monastere|couvent|san |santa|sant'|saint|abbaye|ermitage)/.test(n)) return 'patri-chapelle';
            return 'patri-fouille';
        }
        function drawIcon(g, x, y, kind, col, rr, item) {
            // Resolve la cle exacte du picto + couleur du pin
            var pinKind = (kind === 'cible' || kind === 'target') ? 'cible'
                        : (kind === 'peak') ? 'peak' : 'patri';
            var pictoKey = kind;
            if (kind === 'patri') pictoKey = _patriIconKind(item && item.name);
            else if (kind === 'cible' || kind === 'target') pictoKey = 'cible';
            else pictoKey = 'peak';
            var picto = PICTOS[pictoKey] || PICTOS['patri-fouille'];
            var pinPair = PIN_COLORS[pinKind] || PIN_COLORS.cible;
            // Halo sombre derriere
            g.save();
            g.fillStyle = 'rgba(0,0,0,0.45)';
            g.beginPath(); g.arc(x, y, rr + 5, 0, 2 * Math.PI); g.fill();
            g.fillStyle = 'rgba(0,0,0,0.22)';
            g.beginPath(); g.arc(x, y, rr + 9, 0, 2 * Math.PI); g.fill();
            g.restore();
            // Pin teardrop avec degrade + ombre portee
            g.save();
            g.translate(x, y);
            var s = rr / 10;
            g.scale(s, s);
            // Ombre au sol (ellipse)
            g.fillStyle = 'rgba(0,0,0,0.45)';
            g.fill(PIN_SHADOW);
            // Pin avec degrade
            var grd = g.createLinearGradient(0, -17, 0, 13);
            grd.addColorStop(0, pinPair[0]);
            grd.addColorStop(1, pinPair[1]);
            g.fillStyle = grd;
            g.fill(PIN_PATH);
            g.lineJoin = 'round';
            g.strokeStyle = '#fff';
            g.lineWidth = 1.4 / s;
            g.stroke(PIN_PATH);
            g.strokeStyle = 'rgba(0,0,0,0.45)';
            g.lineWidth = 0.5 / s;
            g.stroke(PIN_PATH);
            // Pictogramme blanc (+ optionnel dark pour les ouvertures)
            if (picto.rotated) {
                g.translate(0, -8);
                g.rotate(-30 * Math.PI / 180);
                g.translate(0, 8);
            }
            g.fillStyle = '#fff';
            if (picto.white) g.fill(picto.white);
            if (picto.dark) {
                g.fillStyle = pinPair[1];
                g.fill(picto.dark);
            }
            g.restore();
        }
        function glyph(g, x, y, kind, col, rr) {
            drawIcon(g, x, y, kind, col, rr);
        }
        function roundRect(g, x, y, w, h, r) {
            g.beginPath();
            g.moveTo(x + r, y);
            g.arcTo(x + w, y, x + w, y + h, r);
            g.arcTo(x + w, y + h, x, y + h, r);
            g.arcTo(x, y + h, x, y, r);
            g.arcTo(x, y, x + w, y, r);
            g.closePath();
        }
        // Pastille label moderne : gradient sombre + pastille kind + nom + sous-texte distance
        function labelChip(g, x, y, name, distTxt, kindCol, kind) {
            var fNa = '600 12.5px system-ui, -apple-system, "Segoe UI", sans-serif';
            var fSu = '500 11px system-ui, sans-serif';
            g.font = fNa;
            var nw = g.measureText(name).width;
            g.font = fSu;
            var sw2 = g.measureText('· ' + distTxt).width;
            var pad = 10, hh = 23, gap = 11;
            var totalW = pad + 9 + gap + nw + 5 + sw2 + pad;
            var bx = x + 13, by = y - hh / 2;
            if (bx + totalW > g.canvas.width - 4) bx = x - totalW - 13;
            // Fond degradé subtile
            var grd = g.createLinearGradient(bx, by, bx, by + hh);
            grd.addColorStop(0, 'rgba(22,30,42,0.93)');
            grd.addColorStop(1, 'rgba(32,40,52,0.86)');
            g.fillStyle = grd;
            roundRect(g, bx, by, totalW, hh, 12);
            g.fill();
            // Filet interieur clair
            g.strokeStyle = 'rgba(255,255,255,0.18)';
            g.lineWidth = 1;
            roundRect(g, bx + 0.5, by + 0.5, totalW - 1, hh - 1, 11.5);
            g.stroke();
            // Pastille couleur kind a gauche (mini-glyphe rond)
            g.fillStyle = kindCol;
            g.beginPath();
            g.arc(bx + pad, by + hh / 2, 4.5, 0, 2 * Math.PI);
            g.fill();
            g.strokeStyle = 'rgba(0,0,0,0.45)';
            g.lineWidth = 0.8; g.stroke();
            g.strokeStyle = 'rgba(255,255,255,0.65)';
            g.lineWidth = 0.8;
            g.beginPath();
            g.arc(bx + pad, by + hh / 2, 4.5, 0, 2 * Math.PI);
            g.stroke();
            // Texte name
            g.font = fNa;
            g.fillStyle = '#fff';
            g.textAlign = 'left'; g.textBaseline = 'middle';
            g.fillText(name, bx + pad + 9 + gap, by + hh / 2 + 0.5);
            // Sous-texte distance, gris clair
            g.font = fSu;
            g.fillStyle = 'rgba(225,235,245,0.78)';
            g.fillText('· ' + distTxt, bx + pad + 9 + gap + nw + 5, by + hh / 2 + 0.5);
        }
        // Superposition de la silhouette du relief calcule (skyline MNT)
        // sur le flux camera : permet de comparer visuellement l'horizon
        // synthetique et le vrai pour caler la boussole sans repere connu.
        // Methode PeakLens-like, calage manuel : on ajuste +/-1deg ou
        // Calibrer jusqu'a ce que la silhouette epouse le relief reel.
        var showRelief = false;
        // Mode "calage par perspective figee" : silhouette dessinee comme
        // si heading == calibAz (donc immobile a l'ecran quand l'utilisateur
        // pivote). Il oriente physiquement le tel pour superposer, et tape
        // "Caler ici" -> headingOffset = calibAz - rawHeading.
        var calibAz = (typeof opts.calibAz === 'number') ? opts.calibAz : null;
        if (calibAz != null) showRelief = true;
        function drawRelief(g, W, H, f, cx, cyH) {
            if (!showRelief || !res.rayProf || !res.rayProf.length) return;
            // En mode calage, on figue la silhouette au centre de l'ecran
            // (anchoree sur calibAz), sinon elle suit le cap (heading).
            var anchor = (calibAz != null) ? calibAz : heading;
            var refPitch = (calibAz != null) ? 0 : pitch;
            var rp = res.rayProf;
            var hasBands = !!(rp[0] && rp[0].bandMax && res.bandOut);
            // Filtre les rayons dans le FOV + projecte chaque bande
            var inFov = [];
            for (var r = 0; r < rp.length; r++) {
                var a = ((rp[r].bearing - anchor + 540) % 360) - 180;
                if (Math.abs(a) > hfov / 2 + 2) continue;
                var x = cx + f * Math.tan(a * Math.PI / 180);
                inFov.push({ x: x, a: a, ray: rp[r] });
            }
            if (inFov.length < 2) return;
            inFov.sort(function(p, q) { return p.a - q.a; });
            function yFromAng(ang) {
                if (ang == null || ang <= -89) return H + 4;
                var y = cyH - f * Math.tan((ang - refPitch) * Math.PI / 180);
                return Math.max(-1500, Math.min(H + 8, y));
            }
            if (hasBands) {
                // SILHOUETTES PAR BANDE : peindre du loin au proche pour que
                // les reliefs proches OCCLUDENT les plus eloignes. Palette
                // topographique : proche = vert-olive profond, mid = gris-vert
                // brumeux, loin = bleu-gris atmospherique (perspective aerienne).
                var NB = res.bandOut.length;
                // Interpolation lineaire entre 3 couleurs cle :
                // t=0   -> RGB(58, 92, 64)   olive forestier
                // t=0.5 -> RGB(120,135,128)  gris-vert
                // t=1   -> RGB(180,200,215)  bleu-gris brume
                var bandFill = function(t, al) {
                    var r, gn, b;
                    if (t < 0.5) {
                        var u = t * 2;
                        r = 58 + u * (120 - 58);
                        gn = 92 + u * (135 - 92);
                        b = 64 + u * (128 - 64);
                    } else {
                        var u2 = (t - 0.5) * 2;
                        r = 120 + u2 * (180 - 120);
                        gn = 135 + u2 * (200 - 135);
                        b = 128 + u2 * (215 - 128);
                    }
                    return 'rgba(' + Math.round(r) + ',' + Math.round(gn) + ','
                        + Math.round(b) + ',' + al + ')';
                };
                var bandLine = function(t) {
                    // Filet plus sombre que le fill (0.55x) pour relief contraste
                    var r, gn, b;
                    if (t < 0.5) {
                        var u = t * 2;
                        r = (58 + u * (120 - 58)) * 0.55;
                        gn = (92 + u * (135 - 92)) * 0.55;
                        b = (64 + u * (128 - 64)) * 0.55;
                    } else {
                        var u2 = (t - 0.5) * 2;
                        r = (120 + u2 * (180 - 120)) * 0.7;
                        gn = (135 + u2 * (200 - 135)) * 0.7;
                        b = (128 + u2 * (215 - 128)) * 0.7;
                    }
                    return 'rgba(' + Math.round(r) + ',' + Math.round(gn) + ','
                        + Math.round(b) + ',' + (0.88 - t * 0.15) + ')';
                };
                for (var bnd = NB - 1; bnd >= 0; bnd--) {
                    var t = (NB > 1) ? bnd / (NB - 1) : 0;     // 0=proche 1=loin
                    // Plus opaque en premier plan, fond atmospherique au loin
                    var al = 0.62 - t * 0.25;
                    g.fillStyle = bandFill(t, al);
                    g.beginPath();
                    g.moveTo(inFov[0].x, H + 4);
                    for (var i = 0; i < inFov.length; i++) {
                        var aa = inFov[i].ray.bandMax
                            ? inFov[i].ray.bandMax[bnd] : -90;
                        g.lineTo(inFov[i].x, yFromAng(aa));
                    }
                    g.lineTo(inFov[inFov.length - 1].x, H + 4);
                    g.closePath(); g.fill();
                    // Trace de l'arete (plus epais en premier plan)
                    g.strokeStyle = bandLine(t);
                    g.lineWidth = (bnd === 0) ? 2.4 : (bnd === 1 ? 1.8 : 1.3);
                    g.lineJoin = 'round';
                    g.beginPath();
                    var started = false;
                    for (var k = 0; k < inFov.length; k++) {
                        var av = inFov[k].ray.bandMax
                            ? inFov[k].ray.bandMax[bnd] : -90;
                        if (av != null && av > -89) {
                            var py = yFromAng(av);
                            if (!started) { g.moveTo(inFov[k].x, py); started = true; }
                            else g.lineTo(inFov[k].x, py);
                        } else { started = false; }
                    }
                    g.stroke();
                }
            } else {
                // Repli : silhouette unique du skyline (anciens res sans bandMax)
                g.fillStyle = 'rgba(255,100,180,0.18)';
                g.beginPath();
                g.moveTo(inFov[0].x, H + 4);
                for (var ii = 0; ii < inFov.length; ii++) {
                    g.lineTo(inFov[ii].x,
                        yFromAng(inFov[ii].ray.sky ? inFov[ii].ray.sky.ang : -90));
                }
                g.lineTo(inFov[inFov.length - 1].x, H + 4);
                g.closePath(); g.fill();
                g.strokeStyle = 'rgba(255,100,180,0.9)';
                g.lineWidth = 2;
                g.beginPath();
                for (var jj = 0; jj < inFov.length; jj++) {
                    var ay = yFromAng(inFov[jj].ray.sky ? inFov[jj].ray.sky.ang : -90);
                    if (jj === 0) g.moveTo(inFov[jj].x, ay);
                    else g.lineTo(inFov[jj].x, ay);
                }
                g.stroke();
            }
        }
        function draw() {
            raf = 0;
            if (dead) return;
            var W = canvas.width, H = canvas.height, g = canvas.getContext('2d');
            g.clearRect(0, 0, W, H);
            var f = (W / 2) / Math.tan((hfov / 2) * Math.PI / 180);
            var cx = W / 2, cyH = H / 2;
            // Silhouette MNT en premier (sous les marqueurs et l'horizon)
            drawRelief(g, W, H, f, cx, cyH);
            // horizon + reticule + cap
            var hy = cyH + f * Math.tan(pitch * Math.PI / 180);
            g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 1;
            g.beginPath(); g.moveTo(0, hy); g.lineTo(W, hy); g.stroke();
            g.strokeStyle = 'rgba(255,255,255,0.6)';
            g.beginPath(); g.moveTo(cx, cyH - 14); g.lineTo(cx, cyH + 14);
            g.moveTo(cx - 14, cyH); g.lineTo(cx + 14, cyH); g.stroke();
            // marqueurs reperes cardinaux
            g.font = 'bold 13px Segoe UI'; g.textAlign = 'center';
            for (var cdir = 0; cdir < 360; cdir += 45) {
                var ca = ((cdir - heading + 540) % 360) - 180;
                if (Math.abs(ca) <= hfov / 2) {
                    var cxp = cx + f * Math.tan(ca * Math.PI / 180);
                    g.fillStyle = 'rgba(255,255,255,0.75)';
                    g.fillText(card(cdir), cxp, 60);
                    g.strokeStyle = 'rgba(255,255,255,0.25)';
                    g.beginPath(); g.moveTo(cxp, 64); g.lineTo(cxp, H); g.stroke();
                }
            }
            g.textAlign = 'left';
            var rects = [];
            // Glyphes + tige d'ancrage + pastille label
            // La tige relie le marqueur a la silhouette synthetique au meme
            // azimut : l'utilisateur voit precisement quel relief porte le
            // marqueur, meme quand le rendu Relief est masque.
            items.slice().sort(_vsByDist).forEach(function(it) {
                var a = ((it.bearing - heading + 540) % 360) - 180;
                if (Math.abs(a) > hfov / 2) return;
                var x = cx + f * Math.tan(a * Math.PI / 180);
                var y = cyH - f * Math.tan((it.ang - pitch) * Math.PI / 180);
                y = Math.max(8, Math.min(H - 12, y));
                var col = _vsPtCol(it.kind === 'patri' ? 'patri'
                    : it.kind === 'peak' ? 'peak' : 'target', it.dist, R);
                var rr = Math.max(7, 11 - 4 * Math.min(1, it.dist / R));
                // Tige d'ancrage : du marqueur vers la ligne d'horizon (ou
                // vers le sol du relief au meme azimut). Plus epaisse en
                // premier plan, en pointille pour les elements lointains.
                var stemY = cyH + f * Math.tan(-pitch * Math.PI / 180); // ligne d'horizon
                // Si on a la skyline du relief pour cet azimut, l'utiliser
                if (res.rayProf && res.rayProf.length) {
                    var nearest = null, bd = 999;
                    for (var ri = 0; ri < res.rayProf.length; ri++) {
                        var diff = Math.abs(((res.rayProf[ri].bearing - it.bearing + 540) % 360) - 180);
                        if (diff < bd) { bd = diff; nearest = res.rayProf[ri]; }
                    }
                    if (nearest && nearest.sky && nearest.sky.ang > it.ang - 2) {
                        stemY = cyH - f * Math.tan((nearest.sky.ang - pitch) * Math.PI / 180);
                    }
                }
                if (stemY > y + 3) {
                    var farT = Math.min(1, it.dist / R);
                    g.strokeStyle = 'rgba(255,255,255,' + (0.85 - 0.4 * farT) + ')';
                    g.lineWidth = farT > 0.6 ? 1.4 : 2;
                    if (farT > 0.6) g.setLineDash([4, 3]); else g.setLineDash([]);
                    g.beginPath();
                    g.moveTo(x, y + rr * 0.7);
                    g.lineTo(x, Math.min(H - 4, stemY));
                    g.stroke();
                    g.setLineDash([]);
                }
                drawIcon(g, x, y, it.kind, col, rr, it);
                labelChip(g, x, y, it.name, dTxt(it.dist), col, it.kind);
            });
            drawMiniMap();
        }
        // -------- Mini-carte Leaflet + overlay --------
        // Le fond Leaflet (tuiles OSM/OpenTopo, perimetre du viewshed et
        // points visibles) est dessine UNE FOIS a l'init. L'overlay canvas
        // ne porte que le secteur FOV + le marqueur Nord (mis a jour a chaque
        // frame). Le tout est nord-en-haut (carte non rotative).
        var miniLMap = null, miniLayers = null;
        function initMiniMap() {
            if (typeof L === 'undefined' || !L.map) return;
            try {
                miniLMap = L.map(miniLeafDiv, {
                    zoomControl: false, attributionControl: false,
                    // Pas de drag (l'observateur doit rester au centre pour
                    // que le secteur FOV soit aligne sur sa position) mais
                    // les zooms sont autorises -- en mode 'center' (pinch
                    // et molette zooment autour du centre, donc l'observateur
                    // ne sort jamais du milieu).
                    dragging: false,
                    scrollWheelZoom: 'center',
                    touchZoom: 'center',
                    doubleClickZoom: 'center',
                    boxZoom: false, keyboard: false,
                    fadeAnimation: false, zoomAnimation: true,
                    inertia: false, minZoom: 5, maxZoom: 19
                });
                miniLeafDiv.style.cursor = 'crosshair';
                // Zoom initial : centre sur l'utilisateur de maniere prononcee
                // (on prend la moitie du rayon comme reference -> l'observateur
                // est dominant et son environnement proche est lisible).
                // L'utilisateur peut dezoomer pour voir la portee complete.
                var radM = res.radiusM || 1000;
                var lat = res.lat;
                var mPerPx = (radM * 0.45) / 70;
                var zCalc = Math.log2(156543.03 * Math.cos(lat * Math.PI / 180) / mPerPx);
                var z = Math.max(8, Math.min(18, Math.round(zCalc)));
                miniLMap.setView([res.lat, res.lon], z);
                L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    maxZoom: 19, crossOrigin: true
                }).addTo(miniLMap);
                miniLayers = L.layerGroup().addTo(miniLMap);
                // Perimetre du viewshed (cercle radius radiusM)
                L.circle([res.lat, res.lon], {
                    radius: radM, color: '#4eafff', weight: 1.5,
                    fillColor: '#4eafff', fillOpacity: 0.04, dashArray: '4,3'
                }).addTo(miniLayers);
                // Echantillon de points visibles (limites a ~400 pour la perf)
                if (res.visPts && res.visPts.length) {
                    var step = Math.max(1, Math.ceil(res.visPts.length / 400));
                    for (var i = 0; i < res.visPts.length; i += step) {
                        var vp = res.visPts[i];
                        L.circleMarker([vp.lat, vp.lon], {
                            radius: 1.2, color: '#7cbf6b', fillColor: '#7cbf6b',
                            fillOpacity: 0.7, weight: 0,
                            interactive: false
                        }).addTo(miniLayers);
                    }
                }
                // Items visibles (sommets / patrimoine / cibles) avec lat/lon
                items.forEach(function(it) {
                    if (it.lat == null || it.lon == null) return;
                    var col = (it.kind === 'patri') ? '#ff66b3'
                        : (it.kind === 'peak') ? '#ffd24a' : '#88c0d0';
                    L.circleMarker([it.lat, it.lon], {
                        radius: 3.5, color: '#000', fillColor: col,
                        fillOpacity: 1, weight: 1, interactive: false
                    }).addTo(miniLayers);
                });
                // Observateur (par-dessus)
                L.circleMarker([res.lat, res.lon], {
                    radius: 5.5, color: '#fff', fillColor: '#4eafff',
                    fillOpacity: 1, weight: 2.2, interactive: false
                }).addTo(miniLayers);
                // Force un repaint apres apparition (sinon tuiles grises)
                setTimeout(function() {
                    try { miniLMap.invalidateSize(); } catch(_e) {}
                }, 120);
                // Tap-to-calibrate : l'utilisateur tape un point qu'il voit
                // dans la camera -> on cale le cap dessus en deduisant
                // l'offset capteur (le seul vrai inconnu : on a deja la
                // direction objective (lat/lon -> bearing) et la direction
                // capteur (rawHeading)).
                // Boutons +/- : zoom autour du centre (pas de pan)
                zInBtn.onclick = function(ev) {
                    ev.stopPropagation(); miniLMap.zoomIn();
                };
                zOutBtn.onclick = function(ev) {
                    ev.stopPropagation(); miniLMap.zoomOut();
                };
                // Garantit que l'observateur reste au centre apres tout zoom
                // (Leaflet peut decentrer subtilement apres invalidateSize).
                miniLMap.on('zoomend', function() {
                    miniLMap.setView([res.lat, res.lon], miniLMap.getZoom(),
                        { animate: false });
                });
                miniLMap.on('click', function(e) {
                    if (calibAz != null) {
                        showToast('Valide d\'abord le calage perspective', 3500);
                        return;
                    }
                    if (!haveHeading) {
                        showToast('Pas de cap detecte. Autoriser la boussole.', 4000);
                        return;
                    }
                    var ll = e.latlng;
                    var bear = _vsBearing(res.lat, res.lon, ll.lat, ll.lng);
                    var distM = _vsDist(res.lat, res.lon, ll.lat, ll.lng);
                    headingOffset = ((bear - rawHeading + 540) % 360) - 180;
                    saveOff(); applyOffset();
                    smX = null; smY = null; lastShownCap = null; tick();
                    showToast('Cap cale : ' + Math.round(bear) + '°'
                        + ' · ' + (distM > 1000
                            ? (distM / 1000).toFixed(1) + ' km'
                            : Math.round(distM) + ' m'), 3500);
                    // Pulse de confirmation a l'endroit tape
                    var puls = L.circleMarker(ll, {
                        radius: 5, color: '#ff8c00', fillColor: '#ffae3a',
                        fillOpacity: 0.95, weight: 2.5, interactive: false
                    }).addTo(miniLayers);
                    setTimeout(function() {
                        try { puls.setStyle({ radius: 16, weight: 1, fillOpacity: 0.15 }); } catch(_e){}
                    }, 60);
                    setTimeout(function() {
                        try { miniLayers.removeLayer(puls); } catch(_e){}
                    }, 1400);
                });
            } catch(_e) {}
        }
        // Overlay canvas : FOV + Nord + (en mode calage) trait perspective
        function drawMiniMap() {
            var ctx = miniOverlay.getContext('2d');
            var W = miniOverlay.width, H = miniOverlay.height;
            ctx.clearRect(0, 0, W, H);
            var mcx = W / 2, mcy = H / 2;
            // Centre de la carte = position observateur (toujours centre du div).
            // On represente la portee comme un cercle "rayon FOV" pour le
            // secteur jaune (rayon = ~70% du demi-cote = la limite viewshed).
            var R = Math.min(mcx, mcy) - 12;
            // Cible perspective (mode calage) : segment pointille violet
            if (calibAz != null) {
                var ta = calibAz * Math.PI / 180;
                ctx.strokeStyle = 'rgba(168,58,138,0.95)';
                ctx.setLineDash([8, 5]);
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(mcx, mcy);
                ctx.lineTo(mcx + (R - 6) * Math.sin(ta),
                           mcy - (R - 6) * Math.cos(ta));
                ctx.stroke();
                ctx.setLineDash([]);
            }
            // Secteur de champ de vision
            if (haveHeading) {
                var hd = heading * Math.PI / 180;
                var halfFov = (hfov / 2) * Math.PI / 180;
                ctx.fillStyle = 'rgba(255,200,80,0.32)';
                ctx.strokeStyle = 'rgba(255,200,80,0.95)';
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.moveTo(mcx, mcy);
                ctx.arc(mcx, mcy, R - 4,
                        hd - halfFov - Math.PI / 2,
                        hd + halfFov - Math.PI / 2);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                // Axe central du regard
                ctx.strokeStyle = 'rgba(255,240,120,1)';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(mcx, mcy);
                ctx.lineTo(mcx + (R - 4) * Math.sin(hd),
                           mcy - (R - 4) * Math.cos(hd));
                ctx.stroke();
            }
            // Marqueur Nord (triangle rouge en haut + N)
            ctx.fillStyle = '#ff3a3a';
            ctx.beginPath();
            ctx.moveTo(mcx, 6);
            ctx.lineTo(mcx - 11, 28);
            ctx.lineTo(mcx + 11, 28);
            ctx.closePath(); ctx.fill();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8; ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 18px Segoe UI';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('N', mcx, 46);
            // Echelle en bas
            ctx.font = '700 13px Segoe UI';
            var radM2 = res.radiusM || 1;
            var rkm = radM2 >= 1000
                ? (radM2 / 1000).toFixed(radM2 >= 10000 ? 0 : 1) + ' km'
                : Math.round(radM2) + ' m';
            ctx.fillStyle = 'rgba(0,0,0,0.65)';
            ctx.fillRect(mcx - 38, H - 22, 76, 16);
            ctx.fillStyle = '#fff';
            ctx.fillText('R = ' + rkm, mcx, H - 14);
        }
        function schedule() { if (!raf && !dead) raf = requestAnimationFrame(draw); }
        function refreshList() {
            var inFov = items.filter(function(it) {
                var a = Math.abs(((it.bearing - heading + 540) % 360) - 180);
                return a <= Math.max(hfov / 2, 35);
            }).map(function(it) {
                it._off = ((it.bearing - heading + 540) % 360) - 180; return it;
            }).sort(function(a, b) {
                return Math.abs(a._off) - Math.abs(b._off) || a.dist - b.dist;
            });
            var gl = { peak: '▲', patri: '◆', cible: '●' };
            list.innerHTML = '<div style="font-weight:600;margin-bottom:6px;">Dans la '
                + 'direction (cap ' + Math.round(heading) + '° ' + card(heading) + ') — '
                + inFov.length + ' element(s)</div>'
                + (inFov.length ? inFov.map(function(it) {
                    var off = Math.round(it._off);
                    var ar = off < -1 ? ('‹ ' + (-off) + '°')
                        : off > 1 ? (off + '° ›') : '◉ face';
                    return '<div style="display:flex;gap:8px;align-items:center;'
                        + 'padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.12);">'
                        + '<span style="width:54px;color:#cfd8dc;">' + ar + '</span>'
                        + '<span style="width:14px;color:' + _vsPtCol(it.kind === 'patri' ? 'patri'
                            : it.kind === 'peak' ? 'peak' : 'target', it.dist, R) + ';">'
                        + (gl[it.kind] || '●') + '</span>'
                        + '<span style="flex:1;">' + escapeHtml(it.name) + '</span>'
                        + '<span style="color:#b0bec5;">' + dTxt(it.dist) + '</span></div>';
                }).join('') : '<div style="opacity:0.7;">Rien de visible dans cette direction.</div>');
        }
        var listOpen = false;
        function tick() { schedule(); if (listOpen) refreshList(); }
        var capEl = hud.querySelector('#pwaCamCap');
        var lastCapUpd = 0;
        function setHeading(h) {
            // Lisse l'echantillon brut AVANT toute lecture, sinon les
            // micro-vibrations du magnetometre se voient dans les boutons
            // cardinaux et la barre HUD.
            rawHeading = smoothHeading(((h % 360) + 360) % 360);
            applyOffset();
            var now = Date.now();
            if (now - lastCapUpd > 150) {
                var disp = Math.round(heading);
                if (lastShownCap == null
                    || Math.abs(((disp - lastShownCap + 540) % 360) - 180) >= 2) {
                    capEl.textContent = 'Cap ' + disp + '° ' + card(heading);
                    lastShownCap = disp;
                }
                lastCapUpd = now;
            }
            tick();
        }
        saveOff();
        // Sources de cap acceptees, dans l'ordre :
        //   1) webkitCompassHeading (iOS Safari) -- toujours absolu / boussole
        //   2) deviceorientationabsolute avec absolute=true (Android Chrome)
        //      -> on calcule le cap a partir de l'attitude complete a,b,g
        //         (pas seulement alpha) sinon ca ne marche qu'en portrait
        //         vertical. Voir derivation ci-dessous.
        // ON IGNORE les evenements 'deviceorientation' relatifs (absolute=false
        // sans webkitCompassHeading) : leur alpha derive sans calage au Nord.
        function onOri(ev) {
            var hd = null;
            var pComputed = null;
            if (typeof ev.webkitCompassHeading === 'number'
                && isFinite(ev.webkitCompassHeading)) {
                // iOS Safari : webkitCompassHeading est deja le cap "boussole"
                // du haut physique du device. On compense l'orientation ecran.
                hd = ev.webkitCompassHeading;
                var so = 0;
                try { so = (screen.orientation && screen.orientation.angle)
                    || window.orientation || 0; } catch(_e) {}
                hd = ((hd + so) % 360 + 360) % 360;
                if (typeof ev.beta === 'number' && isFinite(ev.beta)) {
                    pComputed = ev.beta - 90;
                }
            } else if (ev.absolute === true
                && typeof ev.alpha === 'number' && isFinite(ev.alpha)
                && typeof ev.beta === 'number' && isFinite(ev.beta)
                && typeof ev.gamma === 'number' && isFinite(ev.gamma)) {
                // Android Chrome (et autres conformes W3C).
                // Decomposition Z-X'-Y'' (alpha,beta,gamma) -> matrice R.
                // Direction camera dans world frame = -R * [0,0,1]^T
                // Au lieu d'utiliser (360 - alpha) (qui ne marche QUE phone
                // vertical car gimbal lock a beta=90), on projette le vecteur
                // camera sur le plan horizontal pour avoir le cap exact.
                var rad = Math.PI / 180;
                var a = ev.alpha * rad, b = ev.beta * rad, g = ev.gamma * rad;
                var ca = Math.cos(a), sa = Math.sin(a);
                var cb = Math.cos(b), sb = Math.sin(b);
                var cg = Math.cos(g), sg = Math.sin(g);
                var cx = -ca * sg - sa * sb * cg;     // est du camera-forward
                var cy =  ca * sb * cg - sa * sg;     // nord du camera-forward
                var cz = -cb * cg;                    // composante verticale
                var horiz = Math.sqrt(cx * cx + cy * cy);
                if (horiz > 0.001) {
                    hd = (Math.atan2(cx, cy) * 180 / Math.PI + 360) % 360;
                    pComputed = Math.atan2(cz, horiz) * 180 / Math.PI;
                }
                // Pas de + screen.orientation.angle ici : la rotation autour de
                // l'axe camera est deja entierement encodee dans (beta, gamma).
                // Ajouter so introduisait une erreur de 90/180/270 en paysage.
            }
            if (pComputed != null) {
                var p = Math.max(-45, Math.min(45, pComputed));
                smPitch = (smPitch == null) ? p
                    : smPitch * (1 - SMOOTH_PITCH) + p * SMOOTH_PITCH;
                pitch = smPitch;
            }
            if (hd == null) { tick(); return; }
            haveHeading = true;
            setHeading(hd);
            if (manual.style.display !== 'none') manual.style.display = 'none';
        }
        function startOri() {
            // Variables locales pour suivre quelles sources tirent.
            var sawAbs = false;
            var onAbs = function(ev) { sawAbs = true; onOri(ev); };
            // Sur 'deviceorientation', on relaie SEULEMENT si pas de flux abs
            // deja en cours (autrement on l'ignore : doublons + valeurs alpha
            // potentiellement relatives).
            var onMaybe = function(ev) {
                if (sawAbs) return;
                if (typeof ev.webkitCompassHeading === 'number' || ev.absolute === true) {
                    onOri(ev);
                }
            };
            var add = function() {
                window.addEventListener('deviceorientationabsolute', onAbs, true);
                window.addEventListener('deviceorientation', onMaybe, true);
            };
            try {
                if (typeof DeviceOrientationEvent !== 'undefined'
                    && typeof DeviceOrientationEvent.requestPermission === 'function') {
                    DeviceOrientationEvent.requestPermission()
                        .then(function(s) { if (s === 'granted') add(); }).catch(function(){});
                } else add();
            } catch(_e) {}
            // Memoriser les listeners pour pouvoir les retirer dans close()
            onOri._abs = onAbs; onOri._rel = onMaybe;
            // Si pas de cap apres 3 s -> direction manuelle
            setTimeout(function() {
                if (!haveHeading && !dead) {
                    manual.style.display = 'block';
                    var mr = manual.querySelector('#pwaCamM'), mv = manual.querySelector('#pwaCamMv');
                    mr.oninput = function() { mv.textContent = mr.value; setHeading(parseInt(mr.value, 10) || 0); };
                }
            }, 3000);
        }
        navigator.mediaDevices && navigator.mediaDevices.getUserMedia
            ? navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } }, audio: false
              }).then(function(s) {
                stream = s; video.srcObject = s; video.play().catch(function(){});
              }).catch(function(e) {
                video.style.background = '#222';
                capEl.textContent = 'Camera indisponible (' + (e && e.name || 'refus') + ')';
              })
            : (capEl.textContent = 'Camera non supportee');
        startOri();
        tick();
        var onResize = function() { sizeCanvas(); schedule(); };
        window.addEventListener('resize', onResize);
        hud.querySelector('#pwaCamList').onclick = function() {
            listOpen = !listOpen;
            list.style.display = listOpen ? 'block' : 'none';
            if (listOpen) refreshList();
        };
        function nudge(d) {
            headingOffset = ((headingOffset + d + 540) % 360) - 180;
            saveOff(); applyOffset(); tick();
        }
        hud.querySelector('#pwaCamMin').onclick = function() { nudge(-1); };
        hud.querySelector('#pwaCamPlus').onclick = function() { nudge(1); };
        hud.querySelector('#pwaCamRelief').onclick = function() {
            showRelief = !showRelief;
            var b = hud.querySelector('#pwaCamRelief');
            b.style.background = showRelief
                ? 'rgba(255,100,180,0.65)' : 'rgba(255,100,180,0.2)';
            schedule();
        };
        // Affinage automatique : capture une frame, detecte le sky/relief
        // par gradient vertical, et trouve le decalage en pixels qui aligne
        // au mieux la silhouette MNT sur les contours reels.
        function autoRefine() {
            if (xrSession) return { err: 'Affiner non dispo en mode AR (camera prise par ARCore)' };
            if (calibAz != null) return { err: 'Valide d\'abord le calage perspective' };
            if (!res.rayProf || !res.rayProf.length) return { err: 'Pas de viewshed' };
            if (!video.videoWidth || !video.videoHeight) return { err: 'Camera pas prete' };
            var SW = 200, SH = 110;
            var tmp = document.createElement('canvas');
            tmp.width = SW; tmp.height = SH;
            var tctx = tmp.getContext('2d');
            try { tctx.drawImage(video, 0, 0, SW, SH); }
            catch(_e) { return { err: 'Capture camera impossible' }; }
            var img = tctx.getImageData(0, 0, SW, SH).data;
            // Detection : pour chaque colonne, y du gradient vertical max
            // (luminosite au-dessus - en-dessous, positif a la limite ciel/relief)
            var detected = new Array(SW), gradVal = new Array(SW), maxG = 0;
            for (var x = 0; x < SW; x++) {
                var bestG = -Infinity, bestY = -1;
                for (var y = 6; y < SH - 6; y++) {
                    var above = 0, below = 0;
                    for (var dy = 1; dy <= 5; dy++) {
                        var iA = ((y - dy) * SW + x) * 4;
                        var iB = ((y + dy) * SW + x) * 4;
                        above += img[iA] + img[iA + 1] + img[iA + 2];
                        below += img[iB] + img[iB + 1] + img[iB + 2];
                    }
                    var gv = above - below;
                    if (gv > bestG) { bestG = gv; bestY = y; }
                }
                detected[x] = bestY; gradVal[x] = bestG;
                if (bestG > maxG) maxG = bestG;
            }
            // Seuil : on ne garde que les colonnes a gradient marque (>40% du max)
            var thresh = Math.max(maxG * 0.4, 200);
            var nKept = 0;
            for (var xx = 0; xx < SW; xx++) {
                if (gradVal[xx] < thresh) detected[xx] = null;
                else nKept++;
            }
            if (nKept < 25) return { err: 'Pas d\'horizon clair (gradient faible)' };
            // Silhouette synthetique aux memes colonnes, au cap actuel
            var fxPx = (SW / 2) / Math.tan((hfov / 2) * Math.PI / 180);
            var synthY = new Array(SW);
            var rp = res.rayProf;
            for (var xs = 0; xs < SW; xs++) {
                var aOff = Math.atan2(xs - SW / 2, fxPx) * 180 / Math.PI;
                var az = ((heading + aOff) % 360 + 360) % 360;
                var best = null, bd = 999;
                for (var ri = 0; ri < rp.length; ri++) {
                    var dd = Math.abs(((rp[ri].bearing - az + 540) % 360) - 180);
                    if (dd < bd) { bd = dd; best = rp[ri]; }
                }
                if (best && best.sky && best.sky.ang > -89) {
                    synthY[xs] = SH / 2
                        - fxPx * Math.tan((best.sky.ang - pitch) * Math.PI / 180);
                } else synthY[xs] = null;
            }
            // Recherche du decalage en pixels minimisant l'erreur quadratique
            var bestShift = 0, bestErr = Infinity, bestN = 0;
            var maxDx = Math.round(SW * 0.4);
            for (var dx = -maxDx; dx <= maxDx; dx++) {
                var sumSq = 0, cnt = 0;
                for (var x2 = 0; x2 < SW; x2++) {
                    if (detected[x2] == null) continue;
                    var xss = x2 + dx;
                    if (xss < 0 || xss >= SW || synthY[xss] == null) continue;
                    var e = synthY[xss] - detected[x2];
                    sumSq += e * e; cnt++;
                }
                if (cnt < 20) continue;
                var avg = sumSq / cnt;
                if (avg < bestErr) { bestErr = avg; bestShift = dx; bestN = cnt; }
            }
            if (bestErr === Infinity) return { err: 'Pas de correspondance' };
            // Qualite : MSE doit etre raisonnable (sinon faux match)
            if (bestErr > 300) return { err: 'Match peu fiable (silhouette tres differente du reel)' };
            var deltaDeg = Math.atan2(bestShift, fxPx) * 180 / Math.PI;
            // bestShift > 0 -> synth doit decaler droite, donc heading_reel > heading
            // -> on AJOUTE deltaDeg a l'offset.
            headingOffset = ((headingOffset + deltaDeg + 540) % 360) - 180;
            saveOff(); applyOffset(); tick();
            return { delta: deltaDeg, cols: bestN, mse: bestErr };
        }
        hud.querySelector('#pwaCamAuto').onclick = function() {
            var b = hud.querySelector('#pwaCamAuto');
            var oldBg = b.style.background;
            b.style.background = 'rgba(120,200,140,0.65)';
            // Affiche le relief pendant l'affinage (utile pour voir le resultat)
            if (!showRelief) {
                showRelief = true;
                var br = hud.querySelector('#pwaCamRelief');
                if (br) br.style.background = 'rgba(255,100,180,0.65)';
                schedule();
            }
            setTimeout(function() {
                var r = autoRefine();
                b.style.background = oldBg;
                if (r.err) {
                    showToast('Affiner : ' + r.err, 5000);
                } else {
                    var s = (r.delta > 0 ? '+' : '') + r.delta.toFixed(1) + '°';
                    showToast('Affine : ' + s + ' (sur ' + r.cols
                        + ' colonnes, erreur ~' + Math.round(Math.sqrt(r.mse)) + ' px)', 4500);
                }
            }, 80);
        };
        function exitCalib() {
            calibAz = null;
            calibPane.style.display = 'none';
            // Relief reste affiche apres calage (suit le cap maintenant)
            schedule();
            if (hud.querySelector('#pwaCamRelief')) {
                hud.querySelector('#pwaCamRelief').style.background =
                    showRelief ? 'rgba(255,100,180,0.65)' : 'rgba(255,100,180,0.2)';
            }
        }
        if (calibAz != null) {
            calibPane.style.display = 'block';
            var azStr = Math.round(calibAz) + '° '
                + ['N','NE','E','SE','S','SO','O','NO']
                  [Math.round(((calibAz % 360) / 45)) % 8];
            calibPane.innerHTML = '<div style="font-weight:700;font-size:14px;'
                + 'margin-bottom:6px;">Calage sur la perspective (azimut ' + azStr + ')</div>'
                + '<div style="font-size:12px;opacity:0.95;margin-bottom:10px;">'
                + 'La silhouette rose est figee au centre. Tourne le téléphone pour '
                + 'que le RELIEF REEL derriere la camera epouse cette silhouette, '
                + 'puis valide.</div>'
                + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
                + '<button id="pwaCamCalibX" style="background:rgba(255,255,255,0.18);'
                + 'color:#fff;border:1px solid rgba(255,255,255,0.4);border-radius:6px;'
                + 'padding:8px 14px;cursor:pointer;font:600 12px Segoe UI;">'
                + 'Annuler le calage</button>'
                + '<button id="pwaCamCalibOk" style="background:#fff;color:#5a1a4a;'
                + 'border:none;border-radius:6px;padding:8px 14px;cursor:pointer;'
                + 'font:700 13px Segoe UI;">✓ Caler ici</button></div>';
            calibPane.querySelector('#pwaCamCalibX').onclick = exitCalib;
            calibPane.querySelector('#pwaCamCalibOk').onclick = function() {
                // headingOffset tel que (rawHeading + offset) % 360 = calibAz
                var target = calibAz;
                headingOffset = ((target - rawHeading + 540) % 360) - 180;
                saveOff(); applyOffset(); tick();
                exitCalib();
            };
            // Etat visuel du bouton Relief : actif et verrouille en mode calage
            setTimeout(function() {
                var b = hud.querySelector('#pwaCamRelief');
                if (b) b.style.background = 'rgba(255,100,180,0.65)';
            }, 0);
        }
        // Calibrage : choisir un element visible que l'utilisateur pointe au
        // centre de l'ecran -> on aligne le cap sur sa direction connue.
        hud.querySelector('#pwaCamCal').onclick = function() {
            var cm = document.createElement('div');
            cm.style.cssText = 'position:absolute;inset:46px 0 0 0;background:rgba(0,0,0,0.78);'
                + 'color:#fff;padding:10px 12px;overflow:auto;font:13px Segoe UI;z-index:2;';
            var sorted = items.slice().map(function(it) {
                it._cof = ((it.bearing - rawHeading + 540) % 360) - 180; return it;
            }).sort(function(a, b) { return Math.abs(a._cof) - Math.abs(b._cof) || a.dist - b.dist; });
            var gl = { peak: '▲', patri: '◆', cible: '●' };
            // Azimut solaire courant (formule NOAA simplifiee, ~0.5 deg)
            // Permet de caler le cap meme sans repere identifie : il suffit
            // de pointer le soleil (ou sa direction sous nuages legers).
            var sun = _vsSunAzEl(new Date(), res.lat, res.lon);
            var sunRow = '';
            if (sun.alt > -2) {
                var sCol = sun.alt > 0 ? '#f5b800' : '#a98a3b';
                sunRow = '<div id="pwaCamCalSun" class="pwaCamCalRow" '
                    + 'style="display:flex;gap:8px;align-items:center;padding:10px 4px;'
                    + 'background:rgba(245,184,0,0.10);border:1px solid rgba(245,184,0,0.35);'
                    + 'border-radius:6px;margin-bottom:6px;cursor:pointer;">'
                    + '<span style="width:14px;color:' + sCol + ';font-size:16px;">☼</span>'
                    + '<span style="flex:1;"><b>Aligner sur le Soleil</b>'
                    + '<div style="font-size:11px;opacity:0.85;">Pointe le téléphone '
                    + 'vers le soleil et tape ici. Azimut calcule : '
                    + sun.az.toFixed(1) + '° · hauteur '
                    + sun.alt.toFixed(1) + '°' + (sun.alt < 0 ? ' (sous l\'horizon)' : '')
                    + '</div></span></div>';
            }
            var northRow = '<div id="pwaCamCalNorth" class="pwaCamCalRow" '
                + 'style="display:flex;gap:8px;align-items:center;padding:10px 4px;'
                + 'background:rgba(80,160,220,0.10);border:1px solid rgba(80,160,220,0.35);'
                + 'border-radius:6px;margin-bottom:6px;cursor:pointer;">'
                + '<span style="width:14px;color:#5fb0e0;font-size:16px;">↑</span>'
                + '<span style="flex:1;"><b>Pointer vers le Nord</b>'
                + '<div style="font-size:11px;opacity:0.85;">Tiens le téléphone vers '
                + 'le Nord (boussole, sens du soleil, app météo), puis tape ici.'
                + '</div></span></div>';
            var walkRow = '<div id="pwaCamCalWalk" class="pwaCamCalRow" '
                + 'style="display:flex;gap:8px;align-items:center;padding:10px 4px;'
                + 'background:rgba(120,200,140,0.10);border:1px solid rgba(120,200,140,0.35);'
                + 'border-radius:6px;margin-bottom:6px;cursor:pointer;">'
                + '<span style="width:14px;color:#4caf50;font-size:16px;">⇢</span>'
                + '<span style="flex:1;"><b>Estimer depuis ma position (marcher ~15 m)</b>'
                + '<div style="font-size:11px;opacity:0.85;">Tiens le téléphone comme en AR '
                + '(camera vers l\'avant) et marche en ligne droite. Le GPS deduit le cap '
                + 'de la trajectoire — aucun repere ni soleil necessaire.'
                + '</div></span></div>';
            cm.innerHTML = '<div style="font-weight:600;margin-bottom:6px;">'
                + 'Calibrage du cap</div>'
                + '<div style="font-size:11px;opacity:0.85;margin-bottom:8px;">'
                + 'Quatre manieres au choix : repere identifie, Soleil, Nord, ou marche GPS.</div>'
                + walkRow + northRow + sunRow
                + (sorted.length ? '<div style="font-size:11px;opacity:0.7;margin:8px 0 4px;">'
                    + 'Reperes visibles (tries par proximite angulaire)</div>' : '')
                + (sorted.length ? sorted.slice(0, 30).map(function(it, idx) {
                    var col = _vsPtCol(it.kind === 'patri' ? 'patri'
                        : it.kind === 'peak' ? 'peak' : 'target', it.dist, R);
                    return '<div data-i="' + idx + '" class="pwaCamCalRow" '
                        + 'style="display:flex;gap:8px;align-items:center;padding:8px 4px;'
                        + 'border-bottom:1px solid rgba(255,255,255,0.12);cursor:pointer;">'
                        + '<span style="width:14px;color:' + col + ';">'
                        + (gl[it.kind] || '●') + '</span>'
                        + '<span style="flex:1;">' + escapeHtml(it.name) + '</span>'
                        + '<span style="color:#b0bec5;font-size:11px;">'
                        + dTxt(it.dist) + ' · azimut ' + Math.round(it.bearing) + '°</span></div>';
                  }).join('') : '<div style="opacity:0.7;">Aucun element visible.</div>')
                + '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">'
                + '<button id="pwaCamCalReset" style="background:#7f1d1d;color:#fff;border:none;'
                + 'border-radius:6px;padding:7px 12px;cursor:pointer;font:600 12px Segoe UI;">'
                + 'Reinitialiser (offset 0°)</button>'
                + '<span style="flex:1"></span>'
                + '<button id="pwaCamCalX" style="background:#f0ebe3;color:#5a3a1a;border:none;'
                + 'border-radius:6px;padding:7px 12px;cursor:pointer;font:600 12px Segoe UI;">'
                + 'Annuler</button></div>';
            ov.appendChild(cm);
            function closeCal() { cm.remove(); }
            cm.querySelector('#pwaCamCalX').onclick = closeCal;
            cm.querySelector('#pwaCamCalReset').onclick = function() {
                headingOffset = 0; saveOff(); applyOffset(); tick(); closeCal();
            };
            function alignTo(targetAz) {
                headingOffset = ((targetAz - rawHeading + 540) % 360) - 180;
                saveOff(); applyOffset(); tick(); closeCal();
            }
            var nrow = cm.querySelector('#pwaCamCalNorth');
            if (nrow) nrow.onclick = function() { alignTo(0); };
            var srow = cm.querySelector('#pwaCamCalSun');
            if (srow) srow.onclick = function() { alignTo(sun.az); };
            var wrow = cm.querySelector('#pwaCamCalWalk');
            if (wrow) wrow.onclick = function() { closeCal(); _vsCalibrateByWalk(ov, alignTo); };
            cm.querySelectorAll('.pwaCamCalRow').forEach(function(rw) {
                if (!rw.hasAttribute('data-i')) return;
                rw.onclick = function() {
                    var it = sorted[parseInt(rw.dataset.i, 10)];
                    if (!it) return;
                    alignTo(it.bearing);
                };
            });
        };
        // -------- Phase 2 : WebXR immersive-ar (Android Chrome) --------
        // ARCore fournit un cap stabilise par vision (visual-inertial
        // odometry) : ~0.5 deg de stabilite, vs 5-20 deg pour le
        // magnetometre seul. On garde le meme pipeline de rendu, on
        // remplace juste la source du couple (yaw, pitch).
        var xrSession = null, xrRefSpace = null, xrGl = null, xrGlCv = null;
        var smoothBeforeXR = SMOOTH;
        if (navigator.xr && navigator.xr.isSessionSupported) {
            try {
                navigator.xr.isSessionSupported('immersive-ar').then(function(ok) {
                    if (ok && !dead) {
                        var b = hud.querySelector('#pwaCamXR');
                        if (b) b.style.display = '';
                    }
                }).catch(function() {});
            } catch(_e) {}
        }
        // Cap magneto memorise juste avant le passage en XR : sert a caler
        // ARCore sur la boussole a la 1ere frame (pre-calage automatique).
        var xrInitTargetMag = null;
        function _xrLoop(t, frame) {
            if (dead || !xrSession) return;
            var pose = frame.getViewerPose(xrRefSpace);
            if (pose) {
                var m = pose.transform.matrix;
                // forward de la camera = -Z de sa base, en world space
                var fx = -m[8], fy = -m[9], fz = -m[10];
                var horiz = Math.sqrt(fx * fx + fz * fz);
                var yawDeg = (Math.atan2(fx, -fz) * 180 / Math.PI + 360) % 360;
                var pchDeg = Math.atan2(fy, horiz) * 180 / Math.PI;
                pitch = Math.max(-45, Math.min(45, pchDeg));
                haveHeading = true;
                // FOV horizontal reel depuis la matrice de projection ARCore
                // (m[0] = 1 / tan(hfov/2) pour une projection symetrique).
                var v0 = pose.views && pose.views[0];
                if (v0 && v0.projectionMatrix && v0.projectionMatrix[0]) {
                    var hf = Math.atan(1 / v0.projectionMatrix[0]) * 2 * 180 / Math.PI;
                    if (hf > 30 && hf < 100) hfov = hf;
                }
                // Pre-calage : a la 1ere frame valide, on aligne l'offset
                // pour que le cap affiche = cap magneto memorise.
                if (xrInitTargetMag != null) {
                    headingOffset = ((xrInitTargetMag - yawDeg + 540) % 360) - 180;
                    xrInitTargetMag = null;
                    // pas de saveOff() : on ne persiste pas l'offset XR
                }
                setHeading(yawDeg);
            }
            xrSession.requestAnimationFrame(_xrLoop);
        }
        function _xrFinish(sess) {
            sess.updateRenderState({ baseLayer: new XRWebGLLayer(sess, xrGl) });
            sess.requestReferenceSpace('local').then(function(rs) {
                xrRefSpace = rs;
                sess.requestAnimationFrame(_xrLoop);
            });
        }
        function startXR() {
            if (!navigator.xr) return;
            // Memorise l'etat magneto AVANT que les listeners soient retires.
            // - savedMagOffset : offset magneto persistant -> sera restaure a la fin de session
            // - magCapNow : cap corrige courant -> servira de cible pour pre-caler ARCore
            var savedMagOffset = headingOffset;
            var magCapNow = haveHeading ? heading : null;
            navigator.xr.requestSession('immersive-ar', {
                requiredFeatures: ['local'],
                optionalFeatures: ['dom-overlay'],
                domOverlay: { root: ov }
            }).then(function(sess) {
                xrSession = sess;
                // Couper l'ancien flux camera (la session XR en prend le controle)
                // et les listeners boussole (remplaces par la pose ARCore).
                try { if (onOri._abs) window.removeEventListener('deviceorientationabsolute', onOri._abs, true); } catch(_e) {}
                try { if (onOri._rel) window.removeEventListener('deviceorientation', onOri._rel, true); } catch(_e) {}
                try { if (stream) stream.getTracks().forEach(function(t) { t.stop(); }); } catch(_e) {}
                stream = null;
                video.style.visibility = 'hidden';
                // ARCore demarre dans une orientation arbitraire mais on l'aligne
                // automatiquement sur le cap magneto a la 1ere frame valide
                // (xrInitTargetMag est lu par _xrLoop). On NE clobber PAS l'offset
                // magneto sauve sur disque (savedMagOffset restauree a la fin).
                smX = null; smY = null; smPitch = null; lastShownCap = null;
                xrInitTargetMag = magCapNow;
                headingOffset = 0; // valeur intermediaire, ecrasee a la 1ere frame
                // Smoothing tres faible en XR : ARCore est deja stable, le
                // gros lissage casse la reactivite. 0.45 = ~3 frames de lag.
                smoothBeforeXR = SMOOTH; SMOOTH = 0.45;
                // Couche WebGL minimale (XR exige une baseLayer GL meme avec
                // dom-overlay actif ; on la cache, le navigateur peint la
                // camera derriere notre <div> directement).
                xrGlCv = document.createElement('canvas');
                xrGlCv.style.cssText = 'position:absolute;width:1px;height:1px;'
                    + 'opacity:0;pointer-events:none;';
                ov.appendChild(xrGlCv);
                xrGl = xrGlCv.getContext('webgl', { xrCompatible: true })
                    || xrGlCv.getContext('experimental-webgl', { xrCompatible: true });
                if (xrGl && xrGl.makeXRCompatible) {
                    xrGl.makeXRCompatible().then(function() { _xrFinish(sess); })
                        .catch(function() { _xrFinish(sess); });
                } else { _xrFinish(sess); }
                // Bandeau d'invite : si la boussole etait deja calee (offset
                // magneto sauve), l'AR demarre dans le meme cap -> on n'invite
                // a recalibrer qu'au besoin. Sinon, indiquer comment caler.
                var hint = document.createElement('div');
                hint.style.cssText = 'position:absolute;top:46px;left:50%;'
                    + 'transform:translateX(-50%);background:rgba(0,0,0,0.75);'
                    + 'color:#fff;font:600 12px Segoe UI;padding:6px 10px;'
                    + 'border-radius:6px;z-index:3;max-width:90%;text-align:center;';
                hint.textContent = (magCapNow != null)
                    ? 'Mode AR — cale sur la boussole. Tape "Calibrer" pour affiner.'
                    : 'Mode AR — pas de boussole : tape "Calibrer" et choisis Soleil ou Repere.';
                ov.appendChild(hint);
                setTimeout(function() { try { hint.remove(); } catch(_e) {} }, 6500);
                var xrBtn = hud.querySelector('#pwaCamXR');
                if (xrBtn) { xrBtn.style.background = '#5d8b3f';
                    xrBtn.textContent = 'AR ●'; }
                sess.addEventListener('end', function() {
                    xrSession = null; xrRefSpace = null;
                    try { if (xrGlCv) xrGlCv.remove(); } catch(_e) {}
                    xrGlCv = null; xrGl = null;
                    SMOOTH = smoothBeforeXR;
                    // Restaure l'offset magneto sauvegarde (l'offset XR
                    // calcule pendant la session etait specifique a ARCore).
                    headingOffset = savedMagOffset;
                    xrInitTargetMag = null;
                    smX = null; smY = null; smPitch = null; lastShownCap = null;
                    saveOff();
                    if (dead) return;
                    video.style.visibility = '';
                    var bx = hud.querySelector('#pwaCamXR');
                    if (bx) { bx.style.background = '#1e3a5f'; bx.textContent = 'AR'; }
                    // Reprise du mode camera classique
                    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                        navigator.mediaDevices.getUserMedia({
                            video: { facingMode: { ideal: 'environment' } }, audio: false
                        }).then(function(s) {
                            stream = s; video.srcObject = s;
                            video.play().catch(function(){});
                        }).catch(function() {});
                    }
                    // Reactive les listeners filtres (memes wrappers que startOri)
                    startOri();
                });
            }).catch(function(e) {
                alert('Mode AR indisponible : ' + (e && e.message || e));
            });
        }
        hud.querySelector('#pwaCamXR').onclick = function() {
            if (xrSession) { try { xrSession.end(); } catch(_e) {} }
            else startXR();
        };
        function close() {
            dead = true;
            if (raf) cancelAnimationFrame(raf);
            window.removeEventListener('resize', onResize);
            try { if (onOri._abs) window.removeEventListener('deviceorientationabsolute', onOri._abs, true); } catch(_e) {}
            try { if (onOri._rel) window.removeEventListener('deviceorientation', onOri._rel, true); } catch(_e) {}
            if (xrSession) { try { xrSession.end(); } catch(_e) {} xrSession = null; }
            try { if (stream) stream.getTracks().forEach(function(t) { t.stop(); }); } catch(_e) {}
            try { if (miniLMap) { miniLMap.remove(); miniLMap = null; } } catch(_e) {}
            ov.remove();
        }
        hud.querySelector('#pwaCamX').onclick = close;
    }

    // IndexedDB : vues sauvegardees
    function _vsDbPut(v) {
        return openDb().then(function(db) {
            return new Promise(function(res, rej) {
                var tx = db.transaction(VS_STORE, 'readwrite');
                var rq = tx.objectStore(VS_STORE).put(v);
                rq.onsuccess = function() { res(); }; rq.onerror = function() { rej(rq.error); };
            });
        });
    }
    function _vsDbAll() {
        return openDb().then(function(db) {
            return new Promise(function(res) {
                var tx = db.transaction(VS_STORE, 'readonly');
                var rq = tx.objectStore(VS_STORE).getAll();
                rq.onsuccess = function() { res(rq.result || []); };
                rq.onerror = function() { res([]); };
            });
        }).catch(function() { return []; });
    }
    function _vsDbGet(id) {
        return openDb().then(function(db) {
            return new Promise(function(res) {
                var tx = db.transaction(VS_STORE, 'readonly');
                var rq = tx.objectStore(VS_STORE).get(id);
                rq.onsuccess = function() { res(rq.result || null); };
                rq.onerror = function() { res(null); };
            });
        }).catch(function() { return null; });
    }
    function _vsDbDel(id) {
        return openDb().then(function(db) {
            return new Promise(function(res, rej) {
                var tx = db.transaction(VS_STORE, 'readwrite');
                var rq = tx.objectStore(VS_STORE).delete(id);
                rq.onsuccess = function() { res(); }; rq.onerror = function() { rej(rq.error); };
            });
        });
    }

    function _vsLayerName(l) {
        try {
            if (l.options && l.options.title) return String(l.options.title);
            var c = (l.getTooltip && l.getTooltip() && l.getTooltip().getContent())
                || (l.getPopup && l.getPopup() && l.getPopup().getContent()) || '';
            if (typeof c !== 'string' && c && c.innerText) c = c.innerText;
            c = String(c).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            return c.slice(0, 40);
        } catch(_e) { return ''; }
    }
    // Nom AFFICHE d'un point. Pour un point perso (feature collaborative),
    // on prend le vrai champ "name" de la feature (via customFeaturesData /
    // featureId) -> SANS la categorie ni le reste du popup, pour ne pas
    // surcharger la vue tangentielle.
    function _vsFeatName(l) {
        try {
            if (l && l.featureId != null && Array.isArray(window.customFeaturesData)) {
                for (var i = 0; i < window.customFeaturesData.length; i++) {
                    var f = window.customFeaturesData[i];
                    if (f && f.id === l.featureId)
                        return String(f.name || f.nom || '').trim().slice(0, 48)
                            || _vsLayerName(l);
                }
            }
        } catch(_e) {}
        var n = _vsLayerName(l);
        if (l && l._customCategory) {  // retirer la categorie du blob popup
            var cat = String(l._customCategory);
            n = n.split(cat).join(' ').replace(/^[\s\-–—:|]+/, '')
                 .replace(/[\s\-–—:|]+$/, '').replace(/\s+/g, ' ').trim();
        }
        return n.slice(0, 40);
    }
    // Points proches (marqueurs Leaflet) dans le rayon, hors couche viewshed.
    // Un marqueur de feature collaborative ("point perso") porte _customCategory ;
    // les autres marqueurs sont des toponymes. La projection sur la vue depend
    // des choix utilisateur (showPerso / showTopo).
    function _vsCollectTargets(map, lat, lon, radiusM, showPerso, showTopo) {
        if (!showPerso && !showTopo) return [];
        var t = [];
        map.eachLayer(function(l) {
            try {
                if (!l || !l.getLatLng) return;
                if (typeof l.getChildCount === 'function') return;  // amas de cluster
                if (_vsLayer && _vsLayer.hasLayer && _vsLayer.hasLayer(l)) return;
                var isPerso = (l._customCategory != null);
                if (isPerso ? !showPerso : !showTopo) return;
                var ll = l.getLatLng();
                if (!ll) return;
                var d = _vsDist(lat, lon, ll.lat, ll.lng);
                if (d < 25 || d > radiusM) return;  // exclut l'observateur lui-meme
                t.push({ lat: ll.lat, lon: ll.lng, dist: d,
                         name: isPerso ? _vsFeatName(l) : _vsLayerName(l),
                         perso: isPerso });
            } catch(_e) {}
        });
        t.sort(function(a, b) { return a.dist - b.dist; });
        return t.slice(0, 80);
    }

    // Noms de montagnes/sommets dans le rayon, projetes sur la vue tangentielle.
    // Source : OpenStreetMap (natural=peak / volcano) via l'API Overpass —
    // base de reference des sommets nommes, sans cle, bien couverte sur la Corse.
    // Reseau requis (deja le cas pour l'altimetrie). Echec silencieux.
    function _vsFetchPeaks(res, done) {
        function fin(arr) { res.peaks = arr || []; if (done) done(res.peaks); }
        var b = res.bounds, rp = res.rayProf;
        if (!b || !rp) { fin([]); return; }
        var s = b[0][0], w = b[0][1], n = b[1][0], e = b[1][1];
        var bbox = s.toFixed(5) + ',' + w.toFixed(5) + ','
            + n.toFixed(5) + ',' + e.toFixed(5);
        var q = '[out:json][timeout:25];('
            + 'node["natural"="peak"]["name"](' + bbox + ');'
            + 'node["natural"="volcano"]["name"](' + bbox + ');'
            + ');out body;';
        function tryHost(idx) {
            if (idx >= VS_OVERPASS.length) { fin([]); return; }
            var ac = (typeof AbortController === 'function') ? new AbortController() : null;
            var to = setTimeout(function() { try { ac && ac.abort(); } catch(_e) {} }, 20000);
            fetch(VS_OVERPASS[idx] + '?data=' + encodeURIComponent(q),
                  ac ? { signal: ac.signal } : undefined)
                .then(function(r) { return r.ok ? r.json() : null; })
                .then(function(j) {
                    clearTimeout(to);
                    if (!j) { tryHost(idx + 1); return; }
                    var els = (j && j.elements) || [];
                    var cand = [];
                    els.forEach(function(el) {
                        if (el.type !== 'node' || el.lat == null) return;
                        var tg = el.tags || {};
                        var nm = tg.name;
                        if (!nm) return;
                        var d = _vsDist(res.lat, res.lon, el.lat, el.lon);
                        if (d < 25 || d > res.radiusM) return;  // hors rayon
                        if (!res.full) {                        // hors secteur
                            var pb = _vsBearing(res.lat, res.lon, el.lat, el.lon);
                            var dd = Math.abs(((pb - res.azC + 540) % 360) - 180);
                            if (dd > res.azW / 2) return;
                        }
                        cand.push({ name: String(nm), lat: el.lat, lon: el.lon,
                                    dist: d, nature: tg.natural || 'peak' });
                    });
                    cand.sort(function(a, c) { return a.dist - c.dist; });
                    cand = cand.slice(0, 60);
                    if (!cand.length) { fin([]); return; }
                    onCand(cand);
                }).catch(function() { clearTimeout(to); tryHost(idx + 1); });
        }
        function onCand(cand) {
                _vsFetchElev(cand.map(function(p) { return [p.lat, p.lon]; }))
                    .then(function(pe) {
                        var obsTot = res.obsElev + res.obsH;
                        var nR = res.nRays, N = res.N, st = res.stepM;
                        var gate = Math.max(res.rayStep || 2, 1.5);
                        var out = cand.map(function(p, i) {
                            var pz = pe[i] - _vsCurv(p.dist);
                            var pang = Math.atan2(pz - obsTot, p.dist) * 180 / Math.PI;
                            var pbear = _vsBearing(res.lat, res.lon, p.lat, p.lon);
                            var best = null, bd = 999, r;
                            for (r = 0; r < nR; r++) {
                                var diff = Math.abs(((rp[r].bearing - pbear + 540) % 360) - 180);
                                if (diff < bd) { bd = diff; best = rp[r]; }
                            }
                            var ki = Math.min(N - 1, Math.max(0, Math.round(p.dist / st) - 1));
                            var blk = (best && best.maxAng[ki] != null) ? best.maxAng[ki] : -90;
                            return { name: p.name, lat: p.lat, lon: p.lon, dist: p.dist,
                                     nature: p.nature, bearing: pbear, ang: pang,
                                     elev: Math.round(pe[i]),
                                     visible: (bd <= gate) && (pang >= blk + 0.05) };
                        });
                        fin(out);
                    }).catch(function() { fin([]); });
        }
        tryHost(0);
    }

    // Points Patrimoine (donnees locales de la carte : window.getPatrimoine),
    // dans le rayon/secteur, projetes sur la vue. Altimetrie pour l'angle.
    function _vsFetchPatrimoine(res, done) {
        function fin(arr) { res.patrimoine = arr || []; if (done) done(res.patrimoine); }
        var rp = res.rayProf;
        if (!rp || typeof window.getPatrimoine !== 'function') { fin([]); return; }
        var list;
        try { list = window.getPatrimoine(res.lat, res.lon, res.radiusM) || []; }
        catch (_e) { fin([]); return; }
        var cand = [];
        list.forEach(function(it) {
            if (it.lat == null || it.lon == null) return;
            var d = _vsDist(res.lat, res.lon, it.lat, it.lon);
            if (d < 25 || d > res.radiusM) return;
            if (!res.full) {
                var pb = _vsBearing(res.lat, res.lon, it.lat, it.lon);
                var dd = Math.abs(((pb - res.azC + 540) % 360) - 180);
                if (dd > res.azW / 2) return;
            }
            cand.push({ name: String(it.nom || it.layer_name || 'Patrimoine'),
                        lat: it.lat, lon: it.lon, dist: d,
                        nature: it.layer_name || it.type || 'patrimoine' });
        });
        cand.sort(function(a, c) { return a.dist - c.dist; });
        cand = cand.slice(0, 40);
        if (!cand.length) { fin([]); return; }
        _vsFetchElev(cand.map(function(p) { return [p.lat, p.lon]; }))
            .then(function(pe) {
                var obsTot = res.obsElev + res.obsH;
                var nR = res.nRays, N = res.N, st = res.stepM;
                var gate = Math.max(res.rayStep || 2, 1.5);
                fin(cand.map(function(p, i) {
                    var pz = pe[i] - _vsCurv(p.dist);
                    var pang = Math.atan2(pz - obsTot, p.dist) * 180 / Math.PI;
                    var pbear = _vsBearing(res.lat, res.lon, p.lat, p.lon);
                    var best = null, bd = 999, r;
                    for (r = 0; r < nR; r++) {
                        var diff = Math.abs(((rp[r].bearing - pbear + 540) % 360) - 180);
                        if (diff < bd) { bd = diff; best = rp[r]; }
                    }
                    var ki = Math.min(N - 1, Math.max(0, Math.round(p.dist / st) - 1));
                    var blk = (best && best.maxAng[ki] != null) ? best.maxAng[ki] : -90;
                    return { name: p.name, lat: p.lat, lon: p.lon, dist: p.dist,
                             nature: p.nature, bearing: pbear, ang: pang,
                             elev: Math.round(pe[i]),
                             visible: (bd <= gate) && (pang >= blk + 0.05) };
                }));
            }).catch(function() { fin([]); });
    }

    function _vsStart() {
        if ((typeof isAppOffline === 'function') && isAppOffline()) {
            showToast('Champ de visibilite : connexion requise (altimetrie IGN).', 5000);
            return;
        }
        var map = findLeafletMap();
        if (!map) { showToast('Carte non detectee.', 4000); return; }
        // Choix de l'origine : un point sur la carte OU la position GPS.
        // C'est important pour l'AR caméra : si l'utilisateur compte aller
        // sur le terrain, lancer depuis le GPS rend la projection AR exacte
        // a l'endroit ou il se trouve (sinon parallaxe).
        var m = document.createElement('div');
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100065;'
            + 'display:flex;align-items:center;justify-content:center;padding:16px;'
            + 'font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);
        m.innerHTML = '<div style="background:#fff;border-radius:10px;max-width:360px;'
            + 'width:100%;padding:18px 20px;">'
            + '<h2 style="margin:0 0 8px;font-size:16px;color:#5a3a1a;">Origine du champ '
            + 'de visibilite</h2>'
            + '<div style="font-size:12px;color:#7a5a3a;margin-bottom:14px;">'
            + 'Tous les caps, distances et la vue AR sont calcules depuis ce point.</div>'
            + '<button id="pwaVSorigMap" style="width:100%;background:#8b4513;color:#fff;'
            + 'border:none;padding:11px 12px;border-radius:6px;cursor:pointer;font:600 13px '
            + 'Segoe UI;margin-bottom:8px;text-align:left;">'
            + '📍 Choisir un point sur la carte'
            + '<div style="font-weight:400;font-size:11px;opacity:0.9;margin-top:2px;">'
            + 'Pour analyser depuis un site precis (sommet, chapelle, ruine…)</div>'
            + '</button>'
            + '<button id="pwaVSorigGps" style="width:100%;background:#3a7d44;color:#fff;'
            + 'border:none;padding:11px 12px;border-radius:6px;cursor:pointer;font:600 13px '
            + 'Segoe UI;margin-bottom:8px;text-align:left;">'
            + '⇢ Depuis ma position GPS'
            + '<div style="font-weight:400;font-size:11px;opacity:0.9;margin-top:2px;">'
            + 'Pour une vue AR exacte la ou tu te trouves sur le terrain</div>'
            + '</button>'
            + '<div style="display:flex;justify-content:flex-end;">'
            + '<button id="pwaVSorigX" style="background:#f0ebe3;color:#5a3a1a;border:none;'
            + 'padding:7px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">'
            + 'Annuler</button></div></div>';
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(m);
            L.DomEvent.disableScrollPropagation(m);
        }
        m.onclick = function(e) { if (e.target === m) m.remove(); };
        m.querySelector('#pwaVSorigX').onclick = function() { m.remove(); };
        m.querySelector('#pwaVSorigMap').onclick = function() {
            m.remove();
            showToast('Toucher un point sur la carte pour le champ de visibilite.', 5000);
            map.once('click', function(e) {
                _vsParamsModal(e.latlng.lat, e.latlng.lng);
            });
        };
        m.querySelector('#pwaVSorigGps').onclick = function() {
            m.remove();
            if (!navigator.geolocation) {
                showToast('Geolocalisation indisponible sur cet appareil.', 5000);
                return;
            }
            showToast('Acquisition de la position GPS…', 3000);
            navigator.geolocation.getCurrentPosition(function(pos) {
                var c = pos.coords;
                if (c.accuracy != null && c.accuracy > 100) {
                    showToast('Position imprecise (±' + Math.round(c.accuracy)
                        + ' m). Sortir a ciel degage pour mieux.', 5000);
                }
                // Marqueur pour que _vsResultModal ouvre directement la
                // vue Camera apres calcul (cf. res.autoCam).
                window._vsAutoCam = true;
                _vsParamsModal(c.latitude, c.longitude);
            }, function(err) {
                showToast(err && err.code === 1
                    ? 'Geolocalisation refusee. Autoriser l\'acces a la position.'
                    : 'Position introuvable. Se placer a ciel degage et reessayer.', 6000);
            }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
        };
    }

    function _vsParamsModal(lat, lon) {
        var m = document.createElement('div');
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100065;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);
        m.innerHTML =
            '<div style="background:#fff;border-radius:10px;max-width:380px;width:100%;padding:18px 20px;">' +
            '<h2 style="margin:0 0 12px;font-size:16px;color:#5a3a1a;">Champ de visibilite</h2>' +
            '<label style="display:block;font-size:12px;color:#5a3a1a;margin-bottom:10px;">' +
            'Rayon : <span id="pwaVSrv">2.0</span> km<br>' +
            '<input type="range" id="pwaVSr" min="0.5" max="60" step="0.5" value="2" style="width:100%;"></label>' +
            '<label style="display:block;font-size:12px;color:#5a3a1a;margin-bottom:10px;">' +
            'Hauteur observateur (m)<br>' +
            '<input type="number" id="pwaVSh" value="1.7" min="0" max="80" step="0.1" style="width:100%;padding:7px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;"></label>' +
            '<label style="display:block;font-size:12px;color:#5a3a1a;margin-bottom:8px;">' +
            'Ouverture<br>' +
            '<select id="pwaVSw" style="width:100%;padding:7px;border:1px solid #ccc;border-radius:4px;">' +
            '<option value="360" selected>Tout autour (360 deg)</option>' +
            '<option value="180">Secteur 180 deg</option>' +
            '<option value="120">Secteur 120 deg</option>' +
            '<option value="90">Secteur 90 deg</option>' +
            '<option value="60">Secteur 60 deg</option>' +
            '<option value="45">Secteur 45 deg</option>' +
            '</select></label>' +
            '<label id="pwaVSazL" style="display:none;font-size:12px;color:#5a3a1a;margin-bottom:12px;">' +
            'Azimut central (deg, 0=N, 90=E) : <span id="pwaVSazv">0</span><br>' +
            '<input type="range" id="pwaVSaz" min="0" max="350" step="10" value="0" style="width:100%;"></label>' +
            '<div style="font-size:12px;color:#5a3a1a;margin-bottom:12px;">' +
            'Points a projeter sur la vue<br>' +
            '<label style="display:inline-flex;align-items:center;gap:5px;margin:5px 14px 0 0;cursor:pointer;">' +
            '<input type="checkbox" id="pwaVStpPerso"> Points perso</label>' +
            '<label style="display:inline-flex;align-items:center;gap:5px;margin-top:5px;cursor:pointer;">' +
            '<input type="checkbox" id="pwaVStpTopo"> Toponymes</label></div>' +
            '<label style="display:block;font-size:12px;color:#5a3a1a;margin-bottom:10px;">' +
            'Grain du rendu (taille des mailles)<br>' +
            '<select id="pwaVSgrain" style="width:100%;padding:7px;border:1px solid #ccc;border-radius:4px;">' +
            '<option value="15">Tres fin (~15 m)</option>' +
            '<option value="25">Fin (~25 m)</option>' +
            '<option value="40">Moyen (~40 m)</option>' +
            '<option value="70">Gros (~70 m, zones)</option>' +
            '<option value="110">Tres gros (~110 m, zones)</option>' +
            '</select></label>' +
            '<label style="display:block;font-size:12px;color:#5a3a1a;margin-bottom:10px;">' +
            'Style du rendu<br>' +
            '<select id="pwaVSstyle" style="width:100%;padding:7px;border:1px solid #ccc;border-radius:4px;">' +
            '<option value="points">Points (semis)</option>' +
            '<option value="zones">Zones (aplat plein)</option>' +
            '</select></label>' +
            '<div style="font-size:11px;color:#999;margin-bottom:12px;">MNT IGN (RGE ALTI/LiDAR HD) + courbure terrestre. Grain = finesse d\'echantillonnage (fin = plus detaille, plus de requetes, plus lent). Style Zones = les mailles fusionnent en aplat continu meme en tres fin. Au-dela d\'une dizaine de km le pas s\'espace de toute facon.</div>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
            '<button id="pwaVSx" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">Annuler</button>' +
            '<button id="pwaVSgo" style="background:#8b4513;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">Lancer</button>' +
            '</div></div>';
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(m);
            L.DomEvent.disableScrollPropagation(m);
        }
        var rg = m.querySelector('#pwaVSr');
        rg.oninput = function() { m.querySelector('#pwaVSrv').textContent = parseFloat(rg.value).toFixed(1); };
        var wsel = m.querySelector('#pwaVSw');
        var azL = m.querySelector('#pwaVSazL');
        wsel.onchange = function() { azL.style.display = (wsel.value === '360') ? 'none' : 'block'; };
        var az = m.querySelector('#pwaVSaz');
        az.oninput = function() { m.querySelector('#pwaVSazv').textContent = az.value; };
        var ckP = m.querySelector('#pwaVStpPerso'), ckT = m.querySelector('#pwaVStpTopo');
        var grSel = m.querySelector('#pwaVSgrain');
        var stSel = m.querySelector('#pwaVSstyle');
        try {
            ckP.checked = (localStorage.getItem('pwaVSshowPerso') !== '0');  // defaut : actif
            ckT.checked = (localStorage.getItem('pwaVSshowTopo') === '1');   // defaut : inactif
            grSel.value = localStorage.getItem('pwaVSgrain') || '40';        // defaut : Moyen (vue 14:01)
            stSel.value = localStorage.getItem('pwaVSstyle') || 'points';    // defaut : Points (= rendu d'origine)
        } catch(_e) { ckP.checked = true; ckT.checked = false; grSel.value = '40'; stSel.value = 'points'; }
        m.querySelector('#pwaVSx').onclick = function() { m.remove(); };
        m.onclick = function(e) { if (e.target === m) m.remove(); };
        m.querySelector('#pwaVSgo').onclick = function() {
            var rkm = parseFloat(rg.value) || 2;
            var oh = parseFloat(m.querySelector('#pwaVSh').value) || 1.7;
            var aw = parseInt(wsel.value, 10) || 360;
            var ac = parseInt(az.value, 10) || 0;
            var sP = !!ckP.checked, sT = !!ckT.checked;
            var grainM = parseInt(grSel.value, 10) || 40;
            var styleZones = (stSel.value === 'zones');
            try {
                localStorage.setItem('pwaVSshowPerso', sP ? '1' : '0');
                localStorage.setItem('pwaVSshowTopo', sT ? '1' : '0');
                localStorage.setItem('pwaVSgrain', String(grainM));
                localStorage.setItem('pwaVSstyle', styleZones ? 'zones' : 'points');
            } catch(_e) {}
            m.remove();
            _vsCompute({ lat: lat, lon: lon, radiusM: rkm * 1000, obsH: oh,
                         azC: ac, azW: aw, showPerso: sP, showTopo: sT,
                         grainM: grainM, styleZones: styleZones });
        };
    }

    function _vsCompute(P) {
        var lat = P.lat, lon = P.lon, radiusM = P.radiusM, obsH = P.obsH;
        var full = (P.azW >= 360);
        var az0 = full ? 0 : (P.azC - P.azW / 2);
        // Allocation ISOTROPE du budget : on equilibre rayons (angulaire) ET
        // anneaux (radial) pour un meme espacement au sol. Avant, 180 rayons
        // fixes -> a 60 km, 2 km entre rayons = rendu tres grossier malgre un
        // pas radial fin. Le POST gros lots rend ~45000 echantillons abordable.
        // Le grain reste un PLANCHER : grain fin = la finesse permise par le
        // budget ; grain gros = mailles forcees plus grandes (zones, rapide).
        var BUDGET = 45000;
        var azSpan = full ? 360 : P.azW;
        var azRad = azSpan * Math.PI / 180;
        var sBud = Math.sqrt(azRad * radiusM * radiusM / BUDGET);  // espacement isotrope (m)
        var grainFloor = (P.grainM ? Math.max(8, P.grainM)
                                   : Math.min(40, Math.max(10, radiusM / 150)));
        var stepM = Math.max(grainFloor, sBud, 10);
        var N = Math.max(8, Math.round(radiusM / stepM));
        // Nombre de rayons pour que l'arc au bord ~ stepM (grille isotrope).
        var nRays = full
            ? Math.max(24, Math.round(2 * Math.PI * radiusM / stepM))
            : Math.max(3, Math.round(azRad * radiusM / stepM) + 1);
        var rayStep = full ? (360 / nRays) : (P.azW / (nRays - 1));
        // Garde-fou dur (arrondis / grain) : ne pas exceder le budget.
        if (nRays * N > BUDGET * 1.25) {
            N = Math.max(8, Math.floor(BUDGET * 1.25 / nRays));
            stepM = radiusM / N;
        }
        var map = findLeafletMap();
        if (!map) return;
        var targets = _vsCollectTargets(map, lat, lon, radiusM,
            P.showPerso !== false, P.showTopo === true);

        // pts : [observateur] + targets + samples (ray-major)
        var pts = [[lat, lon]];
        targets.forEach(function(t) { pts.push([t.lat, t.lon]); });
        var bearings = [];
        var r, k;
        for (r = 0; r < nRays; r++) {
            var ang = (az0 + r * rayStep + 360) % 360;
            bearings.push(ang);
            for (k = 1; k <= N; k++) pts.push(_vsDest(lat, lon, stepM * k, ang));
        }
        _vsProgShow('Altimetrie 0 / ' + pts.length + '...');
        _vsFetchElev(pts, function(done, tot) {
            _vsProgSet(done < tot
                ? ('Altimetrie ' + done + ' / ' + tot + '...')
                : 'Analyse du relief...');
        }).then(function(elev) {
            _vsProgSet('Analyse du relief...');
            var obsTot = elev[0] + obsH;
            var T = targets.length;
            var sBase = 1 + T;
            // Visibilite par echantillon + skyline par rayon (pour panorama)
            var visPts = [];                 // {lat,lon,d} visibles (planimetrique)
            var rayProf = [];                // par rayon : {bearing, sky, maxAng[], vis[], bandMax[]}
            // Tranches de distance (pour la superposition des reliefs sur la
            // vue tangentielle : couches peintes arriere->avant + estompage).
            // Bandes proches plus fines (perception de profondeur).
            var BANDS = [0.05, 0.12, 0.25, 0.45, 0.70, 1.0].map(function(f) {
                return f * radiusM;
            });
            var NB = BANDS.length;
            var idx = sBase;
            for (r = 0; r < nRays; r++) {
                var maxSlope = -Infinity, sky = { ang: -90, d: 0 };
                var maxAngAt = [];           // angle visible cumule (pour cible)
                var visArr = [];             // visibilite par echantillon (grille)
                var bandMax = [];            // angle max visible par tranche de distance
                for (var bb = 0; bb < NB; bb++) bandMax.push(-90);
                for (k = 1; k <= N; k++) {
                    var d = stepM * k;
                    var z = elev[idx++] - _vsCurv(d);
                    var slope = (z - obsTot) / d;
                    var isVis = (slope >= maxSlope);
                    visArr.push(isVis);
                    if (isVis) {
                        var pos = _vsDest(lat, lon, d, bearings[r]);
                        visPts.push({ lat: pos[0], lon: pos[1], d: d });
                        var ang = Math.atan2(z - obsTot, d) * 180 / Math.PI;
                        if (ang > sky.ang) sky = { ang: ang, d: d };
                        var bi = 0;
                        while (bi < NB - 1 && d > BANDS[bi]) bi++;
                        if (ang > bandMax[bi]) bandMax[bi] = ang;
                    }
                    if (slope > maxSlope) maxSlope = slope;
                    maxAngAt.push(Math.atan(maxSlope) * 180 / Math.PI);
                }
                rayProf.push({ bearing: bearings[r], sky: sky, maxAng: maxAngAt,
                               vis: visArr, bandMax: bandMax });
            }
            // Cibles : bearing/dist/elev + visible ? (via le rayon le plus proche)
            var tgt = [];
            for (var ti = 0; ti < T; ti++) {
                var tt = targets[ti];
                var tz = elev[1 + ti] - _vsCurv(tt.dist);
                var tang = Math.atan2(tz - obsTot, tt.dist) * 180 / Math.PI;
                var tbear = _vsBearing(lat, lon, tt.lat, tt.lon);
                // rayon le plus proche en azimut
                var best = null, bd = 999;
                for (r = 0; r < nRays; r++) {
                    var diff = Math.abs(((bearings[r] - tbear + 540) % 360) - 180);
                    if (diff < bd) { bd = diff; best = rayProf[r]; }
                }
                var ki = Math.min(N - 1, Math.max(0, Math.round(tt.dist / stepM) - 1));
                var blockAng = (best && best.maxAng[ki] != null) ? best.maxAng[ki] : -90;
                // STRICT : rayon vraiment proche (<= 1 pas angulaire) ET cible
                // qui depasse nettement le relief bloquant (marge +0.05 deg,
                // plus de tolerance negative qui laissait passer du masque).
                var vis = (bd <= Math.max(rayStep, 1.5)) && (tang >= blockAng + 0.05);
                tgt.push({ name: tt.name, lat: tt.lat, lon: tt.lon, dist: tt.dist,
                           bearing: tbear, ang: tang, visible: vis });
            }
            var res = {
                id: 'vs-' + Date.now(),
                name: 'Vue ' + new Date().toLocaleDateString('fr-FR') + ' '
                    + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
                lat: lat, lon: lon, obsH: obsH, obsElev: Math.round(elev[0]),
                radiusM: radiusM, azC: P.azC, azW: P.azW, full: full,
                stepM: stepM, N: N, nRays: nRays, rayStep: rayStep,
                styleZones: !!P.styleZones, bandOut: BANDS,
                date: Date.now(), visPts: visPts, rayProf: rayProf, targets: tgt
            };
            _vsRenderPlani(res);
            _vsLast = res;
            try { window._vsLast = res; } catch(_e) {}  // inspection / diagnostic
            res.panoramaURL = _vsBuildPanorama(res);  // dataURL
            res.perspectiveURL = _vsBuildPanoramaPerspective(res);  // dataURL
            _vsProgHide();
            showToast('Champ de visibilite calcule.', 4000);
            _vsResultModal(res);
            // Lancement depuis position GPS : on enchaine direct sur la
            // Camera AR pour eviter a l'utilisateur de naviguer + on ouvre
            // le modal de calibrage automatiquement (Soleil/Marche/Repere).
            if (window._vsAutoCam) {
                window._vsAutoCam = false;
                setTimeout(function() {
                    _vsCameraView(res);
                    setTimeout(function() {
                        var cal = document.getElementById('pwaCamCal');
                        if (cal) cal.click();
                    }, 600);
                }, 300);
            }
            // Enrichissement asynchrone : sommets nommes (OSM) puis Patrimoine
            // (sequentiel pour ne pas cumuler deux series d'altimetrie).
            _vsFetchPeaks(res, function(pk) {
                if (pk && pk.length && _vsLayer) {
                    pk.forEach(function(p) {
                        L.circleMarker([p.lat, p.lon], {
                            radius: 4, weight: 2, color: '#fff',
                            fillColor: p.visible ? '#8a5a2b' : '#9aa3a3', fillOpacity: 1
                        }).bindPopup('▲ ' + escapeHtml(p.name)
                            + (p.elev ? '<br>' + p.elev + ' m' : '')
                            + '<br>' + (p.visible ? 'VISIBLE' : 'masque')
                            + ' · ' + Math.round(p.dist) + ' m').addTo(_vsLayer);
                    });
                }
                _vsFetchPatrimoine(res, function(pa) {
                    if (pa && pa.length && _vsLayer) {
                        pa.forEach(function(p) {
                            L.marker([p.lat, p.lon], {
                                icon: _vsDiamondIcon(p.visible ? '#e8458f' : '#cf8fb5')
                            }).bindPopup('◆ ' + escapeHtml(p.name)
                                + (p.nature ? '<br>' + escapeHtml(p.nature) : '')
                                + '<br>' + (p.visible ? 'VISIBLE' : 'masque')
                                + ' · ' + Math.round(p.dist) + ' m').addTo(_vsLayer);
                        });
                    }
                    if ((pk && pk.length) || (pa && pa.length)) {
                        res.panoramaURL = _vsBuildPanorama(res);
                        res.perspectiveURL = _vsBuildPanoramaPerspective(res);
                        if (typeof res._setPano === 'function') res._setPano();
                    }
                    var msg = [];
                    if (pk && pk.length) msg.push(pk.length + ' sommet(s)');
                    if (pa && pa.length) msg.push(pa.length + ' patrimoine');
                    if (msg.length) showToast(msg.join(' · ') + ' ajoutes a la vue.', 4500);
                });
            });
        }).catch(function(err) {
            _vsProgHide();
            showToast('Echec du calcul : ' + (err && err.message ? err.message : 'erreur reseau'), 6000);
        });
    }

    // Rendu planimetrique : raster canvas (style Pixscape) en imageOverlay
    function _vsRenderPlani(res) {
        var map = findLeafletMap();
        if (!map) return;
        if (_vsLayer) { try { map.removeLayer(_vsLayer); } catch(_e) {} }
        _vsLayer = L.layerGroup().addTo(map);
        var R = res.radiusM;
        var c0 = _vsDest(res.lat, res.lon, R, 0)[0];      // nord lat
        var c180 = _vsDest(res.lat, res.lon, R, 180)[0];  // sud lat
        var cE = _vsDest(res.lat, res.lon, R, 90)[1];     // est lon
        var cW = _vsDest(res.lat, res.lon, R, 270)[1];    // ouest lon
        var north = Math.max(c0, c180), south = Math.min(c0, c180);
        var east = Math.max(cE, cW), west = Math.min(cE, cW);
        // RENDU D'ORIGINE (commit 73e0f5b, le "premier rendu") : semis de
        // carres, 1 par point reellement visible (res.visPts), colore par
        // distance (proche=vert -> loin=bleu, alpha 0.45). C'EST l'effet
        // "pointille/onde". Style Points = carre fixe ~5 px (fidele a
        // l'origine, a tout rayon) ; Style Zones = carre elargi -> aplat.
        var W = 700, H = Math.round(W * (north - south) / (east - west)) || W;
        var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        var ctx = cv.getContext('2d');
        function px(la, lo) {
            return [(lo - west) / (east - west) * W, (north - la) / (north - south) * H];
        }
        var cell;
        if (res.styleZones) {
            // Style "Zones" : carre > espacement quel que soit le grain ->
            // les mailles se recouvrent et fusionnent en aplat continu (meme
            // en tres fin = zones detaillees lisses).
            var sm = res.stepM || 40;
            var sp = (sm / (2 * R)) * W;
            cell = Math.max(3, Math.round(sp * 1.45));
        } else {
            // Style "Points" : carre PETIT et FIXE (~5 px, = rendu d'origine
            // 73e0f5b), independant du grain et du rayon. Le grain ne change
            // que la densite de points. A 60 km le semis est juste plus epars
            // (echantillonnage borne par le budget) mais reste un semis de
            // petits points, jamais de fausses zones grossieres.
            cell = Math.max(3, Math.round(W / 140));
        }
        (res.visPts || []).forEach(function(p) {
            var q = px(p.lat, p.lon);
            var f = Math.min(1, p.d / R);
            ctx.fillStyle = 'rgba(' + Math.round(40 + 60 * f) + ','
                + Math.round(180 - 90 * f) + ',' + Math.round(70 + 150 * f) + ',0.45)';
            ctx.fillRect(q[0] - cell / 2, q[1] - cell / 2, cell, cell);
        });
        var url = cv.toDataURL('image/png');
        res.planiURL = url; res.bounds = [[south, west], [north, east]];
        _vsInjectOverlayStyle();
        L.imageOverlay(url, res.bounds, { opacity: 0.85, interactive: false,
            className: 'pwa-vs-overlay' }).addTo(_vsLayer);
        L.circleMarker([res.lat, res.lon], {
            radius: 6, color: '#fff', weight: 2, fillColor: '#1e8449', fillOpacity: 1
        }).bindPopup('Observation<br>sol ~' + res.obsElev + ' m (+' + res.obsH + ' m)').addTo(_vsLayer);
        res.targets.forEach(function(t) {
            L.circleMarker([t.lat, t.lon], {
                radius: 5, weight: 2, color: '#fff',
                fillColor: t.visible ? '#1e8449' : '#7f8c8d', fillOpacity: 1
            }).bindPopup((t.name || 'Point') + '<br>' + (t.visible ? 'VISIBLE' : 'masque')
                + ' · ' + Math.round(t.dist) + ' m').addTo(_vsLayer);
        });
        try { map.fitBounds(res.bounds, { padding: [20, 20] }); } catch(_e) {}
    }

    // Vue tangentielle : panorama (X=azimut, Y=angle vertical), colore distance,
    // + cibles proches projetees (visible/masque). Renvoie un dataURL.
    function _vsBuildPanorama(res) {
        var rp = res.rayProf;
        var azStart = res.full ? 0 : (res.azC - res.azW / 2);
        var azSpan = res.full ? 360 : res.azW;
        var PAD = 34;                                         // marge axes
        var W = Math.min(1800, Math.max(760, Math.round(azSpan * 4))) + PAD;
        var PW = W - PAD;                                     // largeur panorama
        var minA = 90, maxA = -90;
        rp.forEach(function(p) { if (p.sky.ang > maxA) maxA = p.sky.ang; });
        res.targets.forEach(function(t) { if (!t.visible) return; if (t.ang < minA) minA = t.ang; if (t.ang > maxA) maxA = t.ang; });
        (res.peaks || []).forEach(function(p) { if (!p.visible) return; if (p.ang < minA) minA = p.ang; if (p.ang > maxA) maxA = p.ang; });
        (res.patrimoine || []).forEach(function(p) { if (!p.visible) return; if (p.ang < minA) minA = p.ang; if (p.ang > maxA) maxA = p.ang; });
        var topA = Math.min(75, Math.ceil(maxA + 4));
        var botA = Math.max(-35, Math.floor(Math.min(-4, minA - 3)));
        // Hauteur = MEME echelle angulaire que l'horizontale (1 deg vertical
        // = 1 deg horizontal) -> proportions realistes, plus de tassement.
        var pxDeg = PW / azSpan;
        var H = Math.max(200, Math.min(1100,
            Math.round((topA - botA) * pxDeg)));
        var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        var ctx = cv.getContext('2d'); ctx.lineJoin = 'round';
        function X(az) { return PAD + ((az - azStart + 360) % 360) / azSpan * PW; }
        function Y(a) { return (topA - a) / (topA - botA) * H; }
        // Meta : mapping curseur <-> azimut/angle (sync vue planimetrique)
        res.panoMeta = { W: W, H: H, PAD: PAD, azStart: azStart, azSpan: azSpan,
                         PW: PW, topA: topA, botA: botA };
        var R = res.radiusM;
        function dCol(f) {
            return 'rgb(' + Math.round(46 + 70 * f) + ',' + Math.round(168 - 96 * f)
                + ',' + Math.round(84 + 150 * f) + ')';
        }
        // Ciel : degrade
        var sky = ctx.createLinearGradient(0, 0, 0, Y(0));
        sky.addColorStop(0, '#cfe0ee'); sky.addColorStop(1, '#eaf2f8');
        ctx.fillStyle = sky; ctx.fillRect(PAD, 0, PW, H);
        // Rayons tries par X (ordre azimut affiche)
        var ord = rp.slice().sort(function(a, b) { return X(a.bearing) - X(b.bearing); });
        var hasBands = !!(rp[0] && rp[0].bandMax && res.bandOut);
        function clY(a) { return Math.max(0, Math.min(H, Y(Math.min(a, topA)))); }
        if (hasBands) {
            // RELIEFS SUPERPOSES : une couche de silhouette par tranche de
            // distance, peinte de l'ARRIERE vers l'AVANT. Estompage
            // atmospherique : loin = pale/bleute, proche = soutenu/vert.
            var NB = res.bandOut.length;
            var bandFill = function(t, al) {
                return 'rgba(' + Math.round(46 + 104 * t) + ',' + Math.round(120 + 60 * t)
                    + ',' + Math.round(60 + 145 * t) + ',' + al + ')';
            };
            var bandLine = function(t) {
                return 'rgba(' + Math.round((46 + 104 * t) * 0.55) + ','
                    + Math.round((120 + 60 * t) * 0.55) + ','
                    + Math.round((60 + 145 * t) * 0.6) + ',0.85)';
            };
            for (var bnd = NB - 1; bnd >= 0; bnd--) {
                var t = (NB > 1) ? bnd / (NB - 1) : 0;        // 0=proche 1=loin
                ctx.fillStyle = bandFill(t, 0.96 - 0.4 * t);
                ctx.beginPath();
                ctx.moveTo(X(ord[0].bearing), H);
                ord.forEach(function(p) {
                    var a = p.bandMax ? p.bandMax[bnd] : -90;
                    ctx.lineTo(X(p.bearing), a > -89 ? clY(a) : H);
                });
                ctx.lineTo(X(ord[ord.length - 1].bearing), H);
                ctx.closePath(); ctx.fill();
                ctx.lineWidth = (bnd === 0) ? 2 : 1.4;
                ctx.strokeStyle = bandLine(t);
                ctx.beginPath();
                var started = false;
                ord.forEach(function(p) {
                    var a = p.bandMax ? p.bandMax[bnd] : -90;
                    if (a > -89) {
                        var px = X(p.bearing), py = clY(a);
                        if (!started) { ctx.moveTo(px, py); started = true; }
                        else ctx.lineTo(px, py);
                    } else { started = false; }
                });
                ctx.stroke();
            }
        } else {
            // Repli : silhouette unique (anciens res sans bandMax)
            var grd = ctx.createLinearGradient(0, Y(maxA), 0, H);
            grd.addColorStop(0, '#6b8e4e'); grd.addColorStop(1, '#3d5230');
            ctx.fillStyle = grd; ctx.beginPath();
            ctx.moveTo(X(ord[0].bearing), H);
            ord.forEach(function(p) { ctx.lineTo(X(p.bearing), Y(p.sky.ang)); });
            ctx.lineTo(X(ord[ord.length - 1].bearing), H);
            ctx.closePath(); ctx.fill();
            ctx.lineWidth = 3;
            for (var i = 0; i < ord.length - 1; i++) {
                ctx.strokeStyle = dCol(Math.min(1, ord[i].sky.d / R));
                ctx.beginPath();
                ctx.moveTo(X(ord[i].bearing), Y(ord[i].sky.ang));
                ctx.lineTo(X(ord[i + 1].bearing), Y(ord[i + 1].sky.ang));
                ctx.stroke();
            }
        }
        // Grille angles verticaux + labels (axe gauche)
        ctx.strokeStyle = 'rgba(0,0,0,0.10)'; ctx.fillStyle = '#5a3a1a';
        ctx.font = '10px Segoe UI'; ctx.lineWidth = 1;
        for (var av = Math.ceil(botA / 10) * 10; av <= topA; av += 10) {
            var yy = Y(av);
            ctx.strokeStyle = (av === 0) ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.10)';
            ctx.beginPath(); ctx.moveTo(PAD, yy); ctx.lineTo(W, yy); ctx.stroke();
            ctx.fillStyle = '#5a3a1a';
            ctx.fillText((av > 0 ? '+' : '') + av + '°', 2, Math.min(H - 2, Math.max(9, yy + 3)));
        }
        // Reperes azimut
        ctx.fillStyle = '#34495e'; ctx.font = 'bold 11px Segoe UI';
        var marks = res.full ? [[0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
            [180, 'S'], [225, 'SO'], [270, 'O'], [315, 'NO']]
            : [[azStart, Math.round(azStart) + '°'], [res.azC, 'axe ' + res.azC + '°'],
               [(azStart + azSpan), Math.round((azStart + azSpan) % 360) + '°']];
        marks.forEach(function(mk) {
            var xx = X(mk[0]);
            ctx.strokeStyle = 'rgba(0,0,0,0.18)';
            ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, H); ctx.stroke();
            ctx.fillStyle = '#34495e';
            ctx.fillText(mk[1], Math.min(W - 26, xx + 3), 12);
        });
        var lblRects = [];  // anti-chevauchement des etiquettes (3 types)
        // Cibles projetees : UNIQUEMENT celles strictement visibles depuis le
        // point de vue (les masquees ne sont pas positionnees sur la vue).
        res.targets.slice().sort(_vsByDist).forEach(function(t) {
            if (!t.visible) return;
            if (!res.full) {
                var dd = Math.abs(((t.bearing - res.azC + 540) % 360) - 180);
                if (dd > res.azW / 2) return;
            }
            var x = X(t.bearing), y = Y(t.ang);
            var tc = _vsPtCol('target', t.dist, R), trr = _vsPtR(t.dist, R);
            ctx.strokeStyle = 'rgba(39,174,96,0.45)';
            ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, Y(0)); ctx.stroke();
            ctx.beginPath(); ctx.arc(x, y, trr, 0, 2 * Math.PI);
            ctx.fillStyle = tc;
            ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
            if (t.name) {
                _vsPlaceLabel(ctx, lblRects, x, y,
                    t.name + (t.visible ? '' : ' (masque)'),
                    '10px Segoe UI', '#1b2631', W, H);
            }
        });
        // Sommets nommes (OSM) : UNIQUEMENT ceux dans le champ de visibilite
        // (les masques ne sont plus positionnes sur la vue).
        (res.peaks || []).slice().sort(_vsByDist).forEach(function(p) {
            if (!p.visible) return;
            if (!res.full) {
                var dp = Math.abs(((p.bearing - res.azC + 540) % 360) - 180);
                if (dp > res.azW / 2) return;
            }
            var x = X(p.bearing), y = Y(p.ang);
            var pr = _vsPtR(p.dist, R) + 1;
            ctx.strokeStyle = 'rgba(138,90,43,0.4)';
            ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, Y(0)); ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();                                  // triangle (mont)
            ctx.moveTo(x, y - pr); ctx.lineTo(x - pr, y + pr * 0.66);
            ctx.lineTo(x + pr, y + pr * 0.66);
            ctx.closePath(); ctx.fillStyle = _vsPtCol('peak', p.dist, R); ctx.fill();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3; ctx.stroke();
            _vsPlaceLabel(ctx, lblRects, x, y,
                p.name + (p.elev ? ' ' + p.elev + ' m' : ''),
                'italic 10px Segoe UI', '#5a3a1a', W, H);
        });
        // Points Patrimoine (losange rose) : UNIQUEMENT ceux dans le champ de
        // visibilite (les masques ne sont pas positionnes sur la vue).
        (res.patrimoine || []).slice().sort(_vsByDist).forEach(function(p) {
            if (!p.visible) return;
            if (!res.full) {
                var dp = Math.abs(((p.bearing - res.azC + 540) % 360) - 180);
                if (dp > res.azW / 2) return;
            }
            var x = X(p.bearing), y = Y(p.ang);
            var qr = _vsPtR(p.dist, R) + 0.5;
            ctx.strokeStyle = 'rgba(232,69,143,0.45)';
            ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, Y(0)); ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();                                  // losange
            ctx.moveTo(x, y - qr); ctx.lineTo(x + qr, y);
            ctx.lineTo(x, y + qr); ctx.lineTo(x - qr, y);
            ctx.closePath(); ctx.fillStyle = _vsPtCol('patri', p.dist, R); ctx.fill();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3; ctx.stroke();
            _vsPlaceLabel(ctx, lblRects, x, y, (p.name || 'Patrimoine'),
                '10px Segoe UI', '#c0317a', W, H);
        });
        // Legende profondeur (meme echelle que les couches de relief :
        // proche = vert soutenu -> loin = bleu pale / estompe)
        var lgX = PAD + 8, lgY = H - 14, lgW = 130;
        var lg = ctx.createLinearGradient(lgX, 0, lgX + lgW, 0);
        lg.addColorStop(0, 'rgb(46,120,60)');
        lg.addColorStop(0.5, 'rgb(98,150,132)');
        lg.addColorStop(1, 'rgb(150,180,205)');
        ctx.fillStyle = lg; ctx.fillRect(lgX, lgY, lgW, 8);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1;
        ctx.strokeRect(lgX, lgY, lgW, 8);
        ctx.fillStyle = '#1b2631'; ctx.font = '9px Segoe UI';
        ctx.fillText('proche', lgX, lgY - 2);
        ctx.fillText((R / 1000) + ' km', lgX + lgW - 28, lgY - 2);
        return cv.toDataURL('image/png');
    }

    // 2e vue tangentielle : PROJECTION RECTILIGNE (pinhole / "appareil photo").
    // Perspective reelle : droites conservees, ecartement naturel. Centree sur
    // l'axe du secteur (ou la direction du relief le plus haut en 360),
    // champ de vision limite. Uniquement les elements strictement visibles.
    function _vsBuildPanoramaPerspective(res) {
        var rp = res.rayProf;
        if (!rp || !rp.length) return null;
        var R = res.radiusM, D2R = Math.PI / 180;
        // Centre + champ de vision. L'utilisateur peut pivoter (res.perspAz)
        // et changer l'angle (res.perspFov) depuis la fenetre de resultat.
        var cAz, hfov;
        if (res.full) {
            var top = rp[0];
            rp.forEach(function(p) { if (p.sky.ang > top.sky.ang) top = p; });
            cAz = top.bearing; hfov = 90;
        } else {
            cAz = res.azC; hfov = Math.min(Math.max(res.azW, 20), 110);
        }
        if (typeof res.perspAz === 'number' && isFinite(res.perspAz)) {
            cAz = ((res.perspAz % 360) + 360) % 360;
        }
        if (typeof res.perspFov === 'number' && isFinite(res.perspFov)) {
            hfov = Math.max(30, Math.min(140, res.perspFov));
        }
        function azp(bearing) { return ((bearing - cAz + 540) % 360) - 180; }  // deg
        function inFov(a) { return Math.abs(a) <= hfov / 2 + 0.5; }
        var W = 1100, cx = W / 2;
        var f = (W / 2) / Math.tan((hfov / 2) * D2R);
        // Extremes verticaux (visibles, dans le champ)
        var eMax = -90, eMin = 90;
        rp.forEach(function(p) {
            if (!inFov(azp(p.bearing))) return;
            if (p.sky.ang > eMax) eMax = p.sky.ang;
            if (p.sky.ang < eMin) eMin = p.sky.ang;
        });
        (res.targets || []).forEach(function(t) {
            if (!t.visible || !inFov(azp(t.bearing))) return;
            if (t.ang > eMax) eMax = t.ang; if (t.ang < eMin) eMin = t.ang;
        });
        (res.peaks || []).forEach(function(t) {
            if (!t.visible || !inFov(azp(t.bearing))) return;
            if (t.ang > eMax) eMax = t.ang; if (t.ang < eMin) eMin = t.ang;
        });
        (res.patrimoine || []).forEach(function(t) {
            if (!t.visible || !inFov(azp(t.bearing))) return;
            if (t.ang > eMax) eMax = t.ang; if (t.ang < eMin) eMin = t.ang;
        });
        if (eMax < -89) { eMax = 10; eMin = -5; }
        eMax = Math.min(80, eMax + 3); eMin = Math.max(-30, Math.min(-3, eMin - 2));
        var eMid = (eMax + eMin) / 2;
        var halfV = (eMax - eMin) / 2 + 5;          // demi-champ vertical (+marge)
        var H = Math.round(Math.max(300, Math.min(1000,
            2 * f * Math.tan(halfV * D2R))));
        var cy = H / 2 + f * Math.tan(eMid * D2R);  // horizon (e=0) -> y=cy
        var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        var ctx = cv.getContext('2d'); ctx.lineJoin = 'round';
        function dCol(fr) {
            return 'rgb(' + Math.round(46 + 70 * fr) + ',' + Math.round(168 - 96 * fr)
                + ',' + Math.round(84 + 150 * fr) + ')';
        }
        // Projection pinhole : x = cx + f*tan(a) ; y = cy - f*tan(e)/cos(a)
        function projX(a) { return cx + f * Math.tan(a * D2R); }
        function projY(a, e) { return cy - f * Math.tan(e * D2R) / Math.cos(a * D2R); }
        var horizonY = cy;  // e=0 -> y=cy (droite)
        // Ciel
        var sky = ctx.createLinearGradient(0, 0, 0, horizonY);
        sky.addColorStop(0, '#cfe0ee'); sky.addColorStop(1, '#eaf2f8');
        ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
        // Rayons dans le champ, tries par azimut affiche
        var ord = rp.filter(function(p) { return inFov(azp(p.bearing)); })
            .sort(function(a, b) { return azp(a.bearing) - azp(b.bearing); });
        var hasBands = !!(rp[0] && rp[0].bandMax && res.bandOut);
        function pclY(a, e) { return Math.max(0, Math.min(H, projY(a, e))); }
        if (ord.length >= 2 && hasBands) {
            // Reliefs superposes par tranche de distance (arriere->avant) +
            // estompage atmospherique (loin = pale/bleute, proche = vert).
            var NB = res.bandOut.length;
            var bFill = function(t, al) {
                return 'rgba(' + Math.round(46 + 104 * t) + ',' + Math.round(120 + 60 * t)
                    + ',' + Math.round(60 + 145 * t) + ',' + al + ')';
            };
            var bLine = function(t) {
                return 'rgba(' + Math.round((46 + 104 * t) * 0.55) + ','
                    + Math.round((120 + 60 * t) * 0.55) + ','
                    + Math.round((60 + 145 * t) * 0.6) + ',0.85)';
            };
            for (var bnd = NB - 1; bnd >= 0; bnd--) {
                var t = (NB > 1) ? bnd / (NB - 1) : 0;
                ctx.fillStyle = bFill(t, 0.96 - 0.4 * t);
                ctx.beginPath();
                ctx.moveTo(projX(azp(ord[0].bearing)), H);
                ord.forEach(function(p) {
                    var a = azp(p.bearing), v = p.bandMax ? p.bandMax[bnd] : -90;
                    ctx.lineTo(projX(a), v > -89 ? pclY(a, v) : H);
                });
                ctx.lineTo(projX(azp(ord[ord.length - 1].bearing)), H);
                ctx.closePath(); ctx.fill();
                ctx.lineWidth = (bnd === 0) ? 2 : 1.4; ctx.strokeStyle = bLine(t);
                ctx.beginPath();
                var st0 = false;
                ord.forEach(function(p) {
                    var a = azp(p.bearing), v = p.bandMax ? p.bandMax[bnd] : -90;
                    if (v > -89) {
                        var px = projX(a), py = pclY(a, v);
                        if (!st0) { ctx.moveTo(px, py); st0 = true; }
                        else ctx.lineTo(px, py);
                    } else { st0 = false; }
                });
                ctx.stroke();
            }
        } else if (ord.length >= 2) {
            var grd = ctx.createLinearGradient(0, Math.max(0, projY(0, eMax)), 0, H);
            grd.addColorStop(0, '#6b8e4e'); grd.addColorStop(1, '#3d5230');
            ctx.fillStyle = grd; ctx.beginPath();
            ctx.moveTo(projX(azp(ord[0].bearing)), H);
            ord.forEach(function(p) {
                var a = azp(p.bearing); ctx.lineTo(projX(a), projY(a, p.sky.ang));
            });
            ctx.lineTo(projX(azp(ord[ord.length - 1].bearing)), H);
            ctx.closePath(); ctx.fill();
        }
        // Horizon (droite) + grille d'angles verticaux (courbes echantillonnees)
        ctx.strokeStyle = 'rgba(0,0,0,0.40)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, horizonY); ctx.lineTo(W, horizonY); ctx.stroke();
        ctx.font = '10px Segoe UI';
        for (var ev = Math.ceil(eMin / 10) * 10; ev <= eMax; ev += 10) {
            if (ev === 0) continue;
            ctx.strokeStyle = 'rgba(0,0,0,0.10)'; ctx.beginPath();
            for (var aa = -hfov / 2, first = true; aa <= hfov / 2; aa += 3) {
                var yy = projY(aa, ev);
                if (first) { ctx.moveTo(projX(aa), yy); first = false; }
                else ctx.lineTo(projX(aa), yy);
            }
            ctx.stroke();
            ctx.fillStyle = '#5a3a1a';
            ctx.fillText((ev > 0 ? '+' : '') + ev + '°', cx + 3,
                Math.min(H - 2, Math.max(9, projY(0, ev) - 2)));
        }
        // Reperes azimut (lignes verticales) : cardinaux ou bornes du secteur
        ctx.font = 'bold 11px Segoe UI';
        var allMarks = res.full
            ? [[0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'], [180, 'S'],
               [225, 'SO'], [270, 'O'], [315, 'NO']]
            : [[(res.azC - res.azW / 2 + 360) % 360, ''], [res.azC, 'axe'],
               [(res.azC + res.azW / 2) % 360, '']];
        allMarks.forEach(function(mk) {
            var a = azp(mk[0]); if (!inFov(a)) return;
            var xx = projX(a);
            ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, H); ctx.stroke();
            ctx.fillStyle = '#34495e';
            ctx.fillText(mk[1] || (Math.round(mk[0]) + '°'),
                Math.min(W - 28, xx + 3), 12);
        });
        // Cibles (cercle), sommets (triangle), patrimoine (losange).
        // Tous affiches dans le champ ; non visibles grises.
        var lblRects = [];  // anti-chevauchement des etiquettes
        function drawPin(o, kind) {
            var a = azp(o.bearing); if (!inFov(a)) return;
            // Tous (cibles, sommets, patrimoine) : uniquement si dans le
            // champ de visibilite (les masques ne sont plus positionnes).
            if (!o.visible) return;
            var x = projX(a), y = projY(a, o.ang);
            var col = _vsPtCol(kind === 'patri' ? 'patri' : kind === 'peak' ? 'peak' : 'target',
                o.dist, R);
            var rr = _vsPtR(o.dist, R);
            ctx.strokeStyle = (kind === 'peak' ? 'rgba(138,90,43,0.4)'
                : kind === 'patri' ? 'rgba(232,69,143,0.4)' : 'rgba(39,174,96,0.4)');
            if (kind !== 'target') ctx.setLineDash(kind === 'patri' ? [2, 3] : [3, 3]);
            ctx.lineWidth = 1; ctx.beginPath();
            ctx.moveTo(x, y); ctx.lineTo(x, horizonY); ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            if (kind === 'peak') {
                ctx.moveTo(x, y - rr - 1); ctx.lineTo(x - rr - 1, y + rr * 0.66);
                ctx.lineTo(x + rr + 1, y + rr * 0.66); ctx.closePath();
            } else if (kind === 'patri') {
                ctx.moveTo(x, y - rr); ctx.lineTo(x + rr, y);
                ctx.lineTo(x, y + rr); ctx.lineTo(x - rr, y); ctx.closePath();
            } else {
                ctx.arc(x, y, rr, 0, 2 * Math.PI);
            }
            ctx.fillStyle = col; ctx.fill();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4; ctx.stroke();
            if (o.name) {
                _vsPlaceLabel(ctx, lblRects, x, y,
                    o.name + (kind === 'peak' && o.elev ? ' ' + o.elev + ' m' : ''),
                    (kind === 'peak' ? 'italic ' : '') + '10px Segoe UI',
                    kind === 'peak' ? '#5a3a1a' : kind === 'patri' ? '#c0317a' : '#1b2631',
                    W, H);
            }
        }
        (res.targets || []).slice().sort(_vsByDist).forEach(function(t) { drawPin(t, 'target'); });
        (res.peaks || []).slice().sort(_vsByDist).forEach(function(p) { drawPin(p, 'peak'); });
        (res.patrimoine || []).slice().sort(_vsByDist).forEach(function(p) { drawPin(p, 'patri'); });
        // Legende
        ctx.fillStyle = 'rgba(255,255,255,0.78)'; ctx.fillRect(6, H - 30, 250, 24);
        ctx.fillStyle = '#1b2631'; ctx.font = '10px Segoe UI';
        ctx.fillText('Perspective · axe ' + Math.round(cAz) + '° · champ '
            + Math.round(hfov) + '°', 10, H - 14);
        var lgX = 10, lgY = H - 10, lgW = 110;
        var lg = ctx.createLinearGradient(lgX, 0, lgX + lgW, 0);
        lg.addColorStop(0, dCol(0)); lg.addColorStop(1, dCol(1));
        ctx.fillStyle = lg; ctx.fillRect(lgX + 130, lgY - 6, lgW, 6);
        res.perspMeta = { mode: 'persp', W: W, H: H, cx: cx, cy: cy, f: f,
                          cAz: cAz, hfov: hfov };
        return cv.toDataURL('image/png');
    }

    // Enregistre la vue SUR LA CARTE collaborative : polygone du champ
    // visible (contour exterieur approx) + point d'observation, via
    // custom_features (compatible file hors-ligne, partage avec tous).
    function _vsSaveToMap(res) {
        var SU = window.SUPABASE_URL, SK = window.SUPABASE_KEY;
        if (!SU || !SK) { showToast('Partage indisponible (Supabase absent).', 5000); return; }
        if (!confirm('Enregistrer ce champ de visibilite sur la carte collaborative '
            + '(visible par tous) ?')) return;
        // Empreinte FIDELE : MultiPolygon des cellules reellement visibles
        // (meme condition stricte que le rendu : les 2 rayons voisins voient
        // le bord exterieur). Les vallees masquees restent en creux -> pas de
        // contour englobant qui surestimerait la zone visible.
        var rp = res.rayProf, st = res.stepM, N = res.N, nR = res.nRays;
        function ll(ri, ki) {  // [lon,lat] arrondi
            var pos = (ki === 0) ? [res.lat, res.lon]
                : _vsDest(res.lat, res.lon, st * ki, rp[ri].bearing);
            return [+pos[1].toFixed(6), +pos[0].toFixed(6)];
        }
        var multi = [];
        for (var ri = 0; ri < nR - (res.full ? 0 : 1); ri++) {
            var ri2 = (ri + 1) % nR;
            var va = rp[ri].vis, vb = rp[ri2].vis, k = 0;
            while (k < N) {
                if (!(va[k] && vb[k])) { k++; continue; }
                var k0 = k;
                while (k < N && va[k] && vb[k]) k++;
                var k1 = k - 1;  // run visible [k0..k1]
                multi.push([[ ll(ri, k0), ll(ri, k1 + 1),
                              ll(ri2, k1 + 1), ll(ri2, k0), ll(ri, k0) ]]);
            }
        }
        if (!multi.length) { showToast('Aucune zone visible a enregistrer.', 5000); return; }
        var nVis = res.targets.filter(function(t) { return t.visible; }).length;
        var desc = 'Champ de visibilite · rayon ' + (res.radiusM / 1000) + ' km · '
            + (res.full ? '360 deg' : 'secteur ' + res.azW + ' deg (axe ' + res.azC + ')')
            + ' · obs +' + res.obsH + ' m (sol ~' + res.obsElev + ' m) · '
            + res.targets.length + ' pts proches, ' + nVis + ' visibles';
        var pid = (window.DRAWING_PROJET_ID || window.PROJET_ID || null);
        var auteur = (window.CONTRIBUTEUR || window.contributeurActuel || 'Viewshed');
        function post(body) {
            return fetch(SU + '/rest/v1/custom_features', {
                method: 'POST',
                headers: {
                    'apikey': SK, 'Authorization': 'Bearer ' + SK,
                    'Content-Type': 'application/json', 'Prefer': 'return=minimal'
                },
                body: JSON.stringify(body)
            });
        }
        showToast('Enregistrement sur la carte...', 3000);
        post({
            projet_id: pid, feature_type: 'polygon',
            geometry: { type: 'MultiPolygon', coordinates: multi },
            name: res.name, description: desc, category: 'Visibilite',
            color: '#1e8449', auteur: auteur
        }).then(function() {
            return post({
                projet_id: pid, feature_type: 'point',
                geometry: { type: 'Point', coordinates: [+res.lon.toFixed(6), +res.lat.toFixed(6)] },
                name: 'Observation — ' + res.name,
                description: 'Point d\'observation du champ de visibilite. ' + desc,
                category: 'Visibilite', color: '#c0392b', auteur: auteur
            });
        }).then(function(r) {
            if (r && (r.ok || r.status === 201 || r.status === 204)) {
                showToast('Champ de visibilite enregistre sur la carte.', 5000);
                if (typeof window.loadCustomFeatures === 'function') {
                    setTimeout(function() { window.loadCustomFeatures(); }, 600);
                }
            } else if (r && r.status === 202) {
                showToast('Hors-ligne : enregistrement en file, publie au retour reseau.', 6000);
            } else {
                showToast('Echec de l\'enregistrement (HTTP ' + (r ? r.status : '?') + ').', 6000);
            }
        }).catch(function(e) {
            showToast('Echec : ' + (e && e.message ? e.message : 'erreur reseau'), 6000);
        });
    }

    function _vsResultModal(res) {
        var m = document.createElement('div');
        m.id = 'pwaVSres';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:100070;' +
            'display:flex;align-items:center;justify-content:center;padding:14px;font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);
        var nVis = (res.targets || []).filter(function(t) { return t.visible; }).length;
        var canMap = !!(res.rayProf && res.stepM && res.N);
        var hasMini = !!(res.bounds && res.planiURL);
        var _vsMode = 'cyl';  // 'cyl' (panoramique) | 'persp' (rectiligne)
        var _setPerspAz = null, _perspTmr = null;  // pilotage perspective depuis la mini-carte
        var _vsEnlarged = false;  // fenetre tangentielle agrandie (plein ecran)
        function _curPanoURL() {
            return (_vsMode === 'persp' && res.perspectiveURL)
                ? res.perspectiveURL : res.panoramaURL;
        }
        m.innerHTML =
            '<div id="pwaVScard" style="background:#fff;border-radius:12px;max-width:96vw;max-height:92vh;overflow:auto;padding:16px 18px;box-sizing:border-box;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:12px;">' +
            '<h2 style="margin:0;font-size:16px;color:#5a3a1a;">Vue tangentielle</h2>' +
            '<button id="pwaVSc" style="background:none;border:none;font-size:22px;cursor:pointer;color:#8b7355;">&times;</button>' +
            '</div>' +
            '<div style="font-size:11px;color:#666;margin-bottom:8px;">Azimut horizontal x angle vertical. Couleur = distance. '
            + (res.targets ? res.targets.length : 0) + ' point(s) proche(s) · ' + nVis + ' visible(s)'
            + ((res.peaks && res.peaks.length) ? ' · ' + res.peaks.length + ' sommet(s) nomme(s)' : '') + '.</div>' +
            (res.perspectiveURL ? '<div style="display:flex;gap:6px;margin-bottom:8px;">' +
            '<button id="pwaVSmCyl" style="border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font:600 12px Segoe UI;background:#8b4513;color:#fff;">Panoramique</button>' +
            '<button id="pwaVSmPersp" style="border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font:600 12px Segoe UI;background:#f0ebe3;color:#5a3a1a;">Perspective</button>' +
            '</div>' +
            '<div id="pwaVSpctl" style="display:none;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;font:600 11px Segoe UI;color:#5a3a1a;">' +
            '<label style="display:flex;align-items:center;gap:5px;">Direction <span id="pwaVSpazv">0</span>°' +
            '<input type="range" id="pwaVSpaz" min="0" max="359" step="1" value="0" style="width:160px;"></label>' +
            '<button id="pwaVSpazL" title="Pivoter a gauche" style="border:1px solid #d8cdbb;background:#f0ebe3;border-radius:6px;padding:4px 9px;cursor:pointer;font:600 12px Segoe UI;">◄</button>' +
            '<button id="pwaVSpazR" title="Pivoter a droite" style="border:1px solid #d8cdbb;background:#f0ebe3;border-radius:6px;padding:4px 9px;cursor:pointer;font:600 12px Segoe UI;">►</button>' +
            '<label style="display:flex;align-items:center;gap:5px;">Champ ' +
            '<select id="pwaVSpfov" style="padding:4px;border:1px solid #ccc;border-radius:4px;">' +
            '<option value="60">60°</option><option value="90" selected>90°</option>' +
            '<option value="120">120°</option><option value="140">140°</option></select></label>' +
            '</div>' : '') +
            '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;">' +
            '<div style="flex:1 1 520px;min-width:280px;">' +
            '<canvas id="pwaVSpano" style="display:block;width:100%;border:1px solid #ddd;border-radius:6px;cursor:crosshair;touch-action:none;"></canvas>' +
            '</div>' +
            (hasMini ? '<div style="flex:0 0 auto;text-align:center;">' +
            '<canvas id="pwaVSmini" style="display:block;border:1px solid #ddd;border-radius:6px;cursor:crosshair;touch-action:none;background:#eef3f6;"></canvas>' +
            '<div style="font-size:10px;color:#999;margin-top:3px;">Vue planimetrique</div></div>' : '') +
            '</div>' +
            '<div id="pwaVSread" style="font-size:12px;color:#5a3a1a;margin-top:8px;min-height:16px;">Survoler une vue pour se reperer sur l\'autre.</div>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap;">' +
            '<button id="pwaVSbig" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:9px 14px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">Agrandir</button>' +
            '<button id="pwaVScam" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:9px 14px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">Camera</button>' +
            '<button id="pwaVScamCal" title="Ouvrir la camera en mode calage : superposer la silhouette figee de cette perspective et orienter le telephone pour la faire coincider avec le reel" style="background:#a83a8a;color:#fff;border:none;padding:9px 14px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">Camera : caler sur cette vue</button>' +
            '<button id="pwaVSdl" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:9px 14px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">Telecharger</button>' +
            (canMap ? '<button id="pwaVSmap" style="background:#1e8449;color:#fff;border:none;padding:9px 14px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">Enregistrer sur la carte</button>' : '') +
            '<button id="pwaVSsave" style="background:#8b4513;color:#fff;border:none;padding:9px 14px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">Enregistrer cette vue</button>' +
            '<button id="pwaVSclose" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:9px 14px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">Fermer</button>' +
            '</div></div>';
        if (typeof L !== 'undefined' && L.DomEvent) { L.DomEvent.disableClickPropagation(m); L.DomEvent.disableScrollPropagation(m); }
        function close() { m.remove(); }
        m.querySelector('#pwaVSc').onclick = close;
        m.querySelector('#pwaVSclose').onclick = close;
        m.onclick = function(e) { if (e.target === m) close(); };
        var mapBtn = m.querySelector('#pwaVSmap');
        if (mapBtn) mapBtn.onclick = function() { _vsSaveToMap(res); };
        m.querySelector('#pwaVSsave').onclick = function() {
            var nm = prompt('Nom de la vue :', res.name);
            if (nm == null) return;
            res.name = (nm || res.name).trim();
            _vsDbPut({
                id: res.id, name: res.name, lat: res.lat, lon: res.lon,
                obsH: res.obsH, obsElev: res.obsElev, radiusM: res.radiusM,
                azC: res.azC, azW: res.azW, full: res.full, date: res.date,
                projet_id: (window.DRAWING_PROJET_ID || window.PROJET_ID || null),
                panoramaURL: res.panoramaURL, planiURL: res.planiURL,
                perspectiveURL: res.perspectiveURL, perspMeta: res.perspMeta,
                bounds: res.bounds, panoMeta: res.panoMeta,
                targets: (res.targets || []).map(function(t) {
                    return { name: t.name, lat: t.lat, lon: t.lon,
                             dist: Math.round(t.dist), visible: t.visible };
                }),
                peaks: (res.peaks || []).map(function(p) {
                    return { name: p.name, lat: p.lat, lon: p.lon,
                             dist: Math.round(p.dist), elev: p.elev,
                             bearing: p.bearing, ang: p.ang, visible: p.visible };
                }),
                patrimoine: (res.patrimoine || []).map(function(p) {
                    return { name: p.name, lat: p.lat, lon: p.lon,
                             dist: Math.round(p.dist), nature: p.nature,
                             bearing: p.bearing, ang: p.ang, visible: p.visible };
                })
            }).then(function() { showToast('Vue enregistree : ' + res.name, 4000); });
        };
        // Agrandir : panorama plein ecran, defilement horizontal (lecture fine)
        // Agrandir : bascule TOUTE la fenetre en quasi plein ecran (panorama
        // OU perspective + mini-carte planimetrique en grand, ensemble), avec
        // recalcul des deux canvas. Re-clic = revenir a la taille normale.
        m.querySelector('#pwaVSbig').onclick = function() {
            _vsSetEnlarged(!_vsEnlarged);
        };
        // Vue Camera (realite augmentee legere) : flux camera + cap boussole
        // + overlay approximatif des elements visibles + liste du secteur.
        m.querySelector('#pwaVScam').onclick = function() { _vsCameraView(res); };
        var camCalBtn = m.querySelector('#pwaVScamCal');
        if (camCalBtn) camCalBtn.onclick = function() {
            // Az de la perspective courante (modifiable par le slider direction)
            var az = (typeof res.perspAz === 'number')
                ? ((res.perspAz % 360) + 360) % 360 : 0;
            var fov = (typeof res.perspFov === 'number') ? res.perspFov : null;
            _vsCameraView(res, { calibAz: az, calibFov: fov });
        };
        // Telecharger en local : PNG du panorama + JSON des donnees de la vue
        m.querySelector('#pwaVSdl').onclick = function() {
            var safe = (res.name || 'vue-tangentielle')
                .replace(/[^\w\- ]+/g, '_').slice(0, 60);
            function dl(href, fname, revoke) {
                var a = document.createElement('a');
                a.href = href; a.download = fname;
                document.body.appendChild(a); a.click();
                setTimeout(function() {
                    if (revoke) URL.revokeObjectURL(href);
                    if (a.parentNode) a.parentNode.removeChild(a);
                }, 1500);
            }
            var _pu = _curPanoURL();
            if (_pu) dl(_pu, safe + (_vsMode === 'persp' ? '-perspective' : '-tangentielle') + '.png', false);
            var data = {
                name: res.name, date: res.date, lat: res.lat, lon: res.lon,
                obsH: res.obsH, obsElev: res.obsElev, radiusM: res.radiusM,
                azC: res.azC, azW: res.azW, full: res.full,
                targets: res.targets || [], peaks: res.peaks || []
            };
            var blob = new Blob([JSON.stringify(data, null, 2)],
                                { type: 'application/json' });
            var ju = URL.createObjectURL(blob);
            setTimeout(function() { dl(ju, safe + '.json', true); }, 300);
            showToast('Telechargement : panorama PNG + donnees JSON.', 4000);
        };

        // ---- Curseur synchronise panorama <-> mini-carte planimetrique ----
        var pano = m.querySelector('#pwaVSpano');
        var mini = m.querySelector('#pwaVSmini');
        var readEl = m.querySelector('#pwaVSread');
        var pImg = new Image(), mImg = new Image();
        var pReady = false, mReady = false;
        // panoMeta : defaut si vue ancienne sans meta
        var pm = res.panoMeta || {
            PAD: 34, azStart: res.full ? 0 : (res.azC - res.azW / 2),
            azSpan: res.full ? 360 : res.azW, topA: null, botA: null
        };
        var b = res.bounds;
        var south, west, north, east;
        if (b) { south = b[0][0]; west = b[0][1]; north = b[1][0]; east = b[1][1]; }
        // Relief a l'azimut az. Si dist fournie (survol mini-carte) -> angle
        // de la silhouette JUSQU'A cette distance (maxAng cumule) : la pastille
        // suit le relief proche pointe, et non plus la crete la plus lointaine.
        function reliefAt(az, dist) {
            if (!res.rayProf) return null;
            var best = null, bd = 999;
            res.rayProf.forEach(function(p) {
                var df = Math.abs(((p.bearing - az + 540) % 360) - 180);
                if (df < bd) { bd = df; best = p; }
            });
            if (!best) return null;
            if (dist == null || !res.stepM || !best.maxAng) {
                return { d: best.sky.d, ang: best.sky.ang };
            }
            var nn = (res.N || best.maxAng.length);
            var ki = Math.min(nn - 1, Math.max(0, Math.round(dist / res.stepM) - 1));
            var a = (best.maxAng[ki] != null) ? best.maxAng[ki] : best.sky.ang;
            return { d: dist, ang: a };
        }
        function crestInfo(az) { return reliefAt(az, null); }
        function crestD(az) { var c = crestInfo(az); return c ? c.d : null; }
        // Couleur "profondeur" = meme echelle que les couches de relief :
        // proche = vert, loin = bleu pale -> lecture instinctive proche/loin.
        function _depthCol(d) {
            var t = Math.max(0, Math.min(1, d / (res.radiusM || 1)));
            return 'rgb(' + Math.round(46 + 104 * t) + ',' + Math.round(120 + 60 * t)
                + ',' + Math.round(60 + 145 * t) + ')';
        }
        function _distTxt(d) {
            return d >= 1000 ? (d / 1000).toFixed(d >= 10000 ? 0 : 1) + ' km'
                : Math.round(d) + ' m';
        }
        function drawPano(az, vAng, dist) {
            if (!pReady) return;
            var w = pano.width, h = pano.height;
            var g = pano.getContext('2d');
            g.clearRect(0, 0, w, h); g.drawImage(pImg, 0, 0, w, h);
            if (az == null) return;
            var x, crestY = null;
            var ci = reliefAt(az, dist);
            if (_vsMode === 'persp' && res.perspMeta) {
                var P = res.perspMeta;
                var a = ((az - P.cAz + 540) % 360) - 180;
                a = Math.max(-P.hfov / 2, Math.min(P.hfov / 2, a));
                x = (P.cx + P.f * Math.tan(a * Math.PI / 180)) / P.W * w;
                if (ci) {
                    var pyi = P.cy - P.f * Math.tan(ci.ang * Math.PI / 180)
                        / Math.cos(a * Math.PI / 180);
                    crestY = Math.max(0, Math.min(h, pyi / P.H * h));
                }
            } else {
                var W0 = pm.W || pImg.naturalWidth || w;
                var PADd = (pm.PAD || 34) / W0 * w;
                var PWd = w - PADd;
                x = PADd + ((az - pm.azStart + 360) % 360) / pm.azSpan * PWd;
                if (ci && pm.topA != null && pm.botA != null) {
                    crestY = Math.max(0, Math.min(h,
                        (pm.topA - ci.ang) / (pm.topA - pm.botA) * h));
                }
            }
            // Ligne curseur
            g.strokeStyle = 'rgba(192,57,43,0.85)'; g.lineWidth = 1.5;
            g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
            if (vAng != null && _vsMode !== 'persp' && pm.topA != null && pm.botA != null) {
                var y = (pm.topA - vAng) / (pm.topA - pm.botA) * h;
                g.strokeStyle = 'rgba(192,57,43,0.4)';
                g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
            }
            // Pastille + distance, colorees par profondeur. La distance est
            // celle du point SURVOLE (dist, ex: mini-carte) si fournie ;
            // sinon la crete a cet azimut.
            var dShown = (dist != null) ? dist : (ci ? ci.d : null);
            if (dShown != null) {
                var dy = (crestY != null) ? crestY : 14;
                g.beginPath(); g.arc(x, dy, 6, 0, 2 * Math.PI);
                g.fillStyle = _depthCol(dShown); g.fill();
                g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
                var txt = _distTxt(dShown);
                g.font = 'bold 12px Segoe UI';
                var tw = g.measureText(txt).width;
                var bx = Math.max(2, Math.min(w - tw - 10, x + 9));
                var by = Math.max(16, Math.min(h - 6, dy - 10));
                g.fillStyle = 'rgba(0,0,0,0.62)';
                g.fillRect(bx - 4, by - 13, tw + 8, 17);
                g.fillStyle = '#fff'; g.fillText(txt, bx, by);
            }
        }
        function drawMini(az, dist) {
            if (!mReady || !b) return;
            var w = mini.width, h = mini.height;
            var g = mini.getContext('2d');
            g.clearRect(0, 0, w, h); g.drawImage(mImg, 0, 0, w, h);
            function px(la, lo) {
                return [(lo - west) / (east - west) * w, (north - la) / (north - south) * h];
            }
            var o = px(res.lat, res.lon);
            if (az != null) {
                var ep = _vsDest(res.lat, res.lon, res.radiusM, az);
                var e2 = px(ep[0], ep[1]);
                g.strokeStyle = 'rgba(192,57,43,0.9)'; g.lineWidth = 1.5;
                g.beginPath(); g.moveTo(o[0], o[1]); g.lineTo(e2[0], e2[1]); g.stroke();
                var dd = (dist != null) ? dist : crestD(az);
                if (dd != null) {
                    var dp = _vsDest(res.lat, res.lon, Math.min(dd, res.radiusM), az);
                    var d2 = px(dp[0], dp[1]);
                    g.beginPath(); g.arc(d2[0], d2[1], 4, 0, 2 * Math.PI);
                    g.fillStyle = '#c0392b'; g.fill();
                    g.strokeStyle = '#fff'; g.lineWidth = 1.4; g.stroke();
                }
            }
            g.beginPath(); g.arc(o[0], o[1], 4, 0, 2 * Math.PI);
            g.fillStyle = '#1e8449'; g.fill();
            g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
        }
        function readout(az, dist, vAng) {
            if (az == null) { readEl.textContent = 'Survoler une vue pour se reperer sur l\'autre.'; return; }
            var card = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(((az % 360) / 45)) % 8];
            var s = 'Azimut ' + Math.round((az + 360) % 360) + '° (' + card + ')';
            var dd = (dist != null) ? dist : crestD(az);
            if (dd != null) s += ' · ' + (dd >= 1000 ? (dd / 1000).toFixed(1) + ' km' : Math.round(dd) + ' m');
            if (vAng != null) s += ' · ' + (vAng > 0 ? '+' : '') + vAng.toFixed(1) + '°';
            readEl.textContent = s;
        }
        function syncFromAz(az, dist, vAng) { drawPano(az, vAng, dist); drawMini(az, dist); readout(az, dist, vAng); }
        function evtXY(el, ev) {
            var r = el.getBoundingClientRect();
            var t = (ev.touches && ev.touches[0]) || ev;
            return [(t.clientX - r.left) / r.width, (t.clientY - r.top) / r.height];
        }
        function onPano(ev) {
            if (!pReady) return;
            if (ev.cancelable) ev.preventDefault();
            var f = evtXY(pano, ev), fx = Math.max(0, Math.min(1, f[0])), fy = Math.max(0, Math.min(1, f[1]));
            if (_vsMode === 'persp' && res.perspMeta) {
                var P = res.perspMeta, R2D = 180 / Math.PI;
                var u = (fx * P.W - P.cx) / P.f;
                var aDeg = Math.atan(u) * R2D;             // azimut relatif
                var az = (P.cAz + aDeg + 360) % 360;
                var sy = fy * P.H;
                var vAng = Math.atan(((P.cy - sy) / P.f) * Math.cos(aDeg / R2D)) * R2D;
                syncFromAz(az, null, vAng);
                return;
            }
            var W0 = pm.W || pImg.naturalWidth || 1;
            var PADf = (pm.PAD || 34) / W0;
            var az2 = pm.azStart + (Math.max(0, fx - PADf) / Math.max(0.01, 1 - PADf)) * pm.azSpan;
            az2 = (az2 + 360) % 360;
            var vAng2 = (pm.topA != null && pm.botA != null) ? (pm.topA - fy * (pm.topA - pm.botA)) : null;
            syncFromAz(az2, null, vAng2);
        }
        function onMini(ev) {
            if (!mReady || !b) return;
            if (ev.cancelable) ev.preventDefault();
            var f = evtXY(mini, ev), fx = Math.max(0, Math.min(1, f[0])), fy = Math.max(0, Math.min(1, f[1]));
            var lo = west + fx * (east - west), la = north - fy * (north - south);
            var az = _vsBearing(res.lat, res.lon, la, lo);
            var dist = _vsDist(res.lat, res.lon, la, lo);
            syncFromAz(az, dist, null);
            // En mode Perspective : recentrer la vue sur l'azimut pointe
            // (immediat au clic/tap, leger differe au survol).
            if (_vsMode === 'persp' && _setPerspAz) {
                var imm = (ev.type === 'click' || ev.type === 'touchstart'
                    || ev.type === 'touchend');
                _setPerspAz(az, imm);
            }
        }
        // Dimensionnement des 2 canvas (recalcule a l'agrandissement aussi).
        function fitPano() {
            if (!pReady) return;
            var cap = _vsEnlarged ? pImg.naturalWidth * 2 : pImg.naturalWidth;
            var cw = Math.min(pano.parentElement.clientWidth || 760, cap);
            pano.width = Math.max(200, Math.round(cw));
            pano.height = Math.round(pano.width * pImg.naturalHeight / pImg.naturalWidth);
            drawPano(null);
        }
        function fitMini() {
            if (!mReady) return;
            var maxD = _vsEnlarged
                ? Math.max(260, Math.round(Math.min(window.innerHeight * 0.6,
                    window.innerWidth * 0.42)))
                : 300;
            var ar = (east - west) / (north - south);
            var mw = ar >= 1 ? maxD : Math.round(maxD * ar);
            var mh = ar >= 1 ? Math.round(maxD / ar) : maxD;
            mini.width = mw; mini.height = mh;
            mini.style.width = mw + 'px'; mini.style.height = mh + 'px';
            drawMini(null);
        }
        function _vsSetEnlarged(on) {
            _vsEnlarged = !!on;
            var card = m.querySelector('#pwaVScard');
            var bb = m.querySelector('#pwaVSbig');
            if (card) {
                if (_vsEnlarged) {
                    card.style.maxWidth = '99vw'; card.style.maxHeight = '97vh';
                    card.style.width = '99vw'; card.style.height = '97vh';
                } else {
                    card.style.width = ''; card.style.height = '';
                    card.style.maxWidth = '96vw'; card.style.maxHeight = '92vh';
                }
            }
            if (bb) bb.textContent = _vsEnlarged ? 'Reduire' : 'Agrandir';
            // Laisser le layout se recalculer avant de redimensionner les canvas.
            setTimeout(function() { fitPano(); if (hasMini) fitMini(); }, 40);
        }
        pImg.onload = function() { pReady = true; fitPano(); };
        pImg.src = _curPanoURL();
        if (hasMini) {
            mImg.onload = function() { mReady = true; fitMini(); };
            mImg.src = res.planiURL;
            mini.addEventListener('mousemove', onMini);
            mini.addEventListener('click', onMini);
            mini.addEventListener('touchmove', onMini, { passive: false });
            mini.addEventListener('touchstart', onMini, { passive: false });
        }
        pano.addEventListener('mousemove', onPano);
        pano.addEventListener('touchmove', onPano, { passive: false });
        pano.addEventListener('touchstart', onPano, { passive: false });
        // (Re)charge l'image du mode courant (panoramique ou perspective)
        function reloadPano() {
            pReady = false;
            pImg.onload = function() { pReady = true; fitPano(); };
            pImg.src = _curPanoURL();
        }
        // Hook : rafraichir quand les sommets arrivent (asynchrone)
        res._setPano = function() { reloadPano(); };
        // Bascule Panoramique <-> Perspective
        var bCyl = m.querySelector('#pwaVSmCyl');
        var bPersp = m.querySelector('#pwaVSmPersp');
        function setMode(md) {
            if (md === 'persp' && !res.perspectiveURL) return;
            _vsMode = md;
            if (bCyl && bPersp) {
                var on = 'background:#8b4513;color:#fff;', off = 'background:#f0ebe3;color:#5a3a1a;';
                bCyl.style.cssText = 'border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font:600 12px Segoe UI;' + (md === 'cyl' ? on : off);
                bPersp.style.cssText = 'border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font:600 12px Segoe UI;' + (md === 'persp' ? on : off);
            }
            if (pctl) pctl.style.display = (md === 'persp' && canPersp) ? 'flex' : 'none';
            reloadPano();
        }
        // Controles perspective : pivoter (direction) + champ de vision.
        // Possible seulement si on peut re-rendre (res.rayProf present).
        var pctl = m.querySelector('#pwaVSpctl');
        var pazEl = m.querySelector('#pwaVSpaz'), pazv = m.querySelector('#pwaVSpazv');
        var pfovEl = m.querySelector('#pwaVSpfov');
        var canPersp = !!(res.rayProf && pctl);
        function _snapFov(h) {
            var opts = [60, 90, 120, 140], best = 90, bd = 1e9;
            opts.forEach(function(o) { var d = Math.abs(o - h); if (d < bd) { bd = d; best = o; } });
            return best;
        }
        if (canPersp) {
            var c0 = (res.perspMeta && res.perspMeta.cAz != null)
                ? Math.round(res.perspMeta.cAz)
                : (typeof res.perspAz === 'number' ? Math.round(res.perspAz) : 0);
            c0 = ((c0 % 360) + 360) % 360;
            pazEl.value = String(c0); pazv.textContent = String(c0);
            if (res.perspMeta && res.perspMeta.hfov) pfovEl.value = String(_snapFov(res.perspMeta.hfov));
            var rebuildPersp = function() {
                res.perspAz = parseInt(pazEl.value, 10) || 0;
                res.perspFov = parseInt(pfovEl.value, 10) || 90;
                res.perspectiveURL = _vsBuildPanoramaPerspective(res);
                reloadPano();
            };
            pazEl.oninput = function() { pazv.textContent = pazEl.value; };
            pazEl.onchange = rebuildPersp;
            pfovEl.onchange = rebuildPersp;
            // Permet a la mini-carte de piloter la direction (debounce si survol).
            _setPerspAz = function(az, immediate) {
                az = Math.round(((az % 360) + 360) % 360);
                pazEl.value = String(az); pazv.textContent = String(az);
                if (_perspTmr) { clearTimeout(_perspTmr); _perspTmr = null; }
                if (immediate) rebuildPersp();
                else _perspTmr = setTimeout(function() { _perspTmr = null; rebuildPersp(); }, 180);
            };
            function rotate(d) {
                var v = ((parseInt(pazEl.value, 10) || 0) + d + 360) % 360;
                pazEl.value = String(v); pazv.textContent = String(v); rebuildPersp();
            }
            var bL = m.querySelector('#pwaVSpazL'), bR = m.querySelector('#pwaVSpazR');
            if (bL) bL.onclick = function() { rotate(-15); };
            if (bR) bR.onclick = function() { rotate(15); };
        }
        if (bCyl) bCyl.onclick = function() { setMode('cyl'); };
        if (bPersp) bPersp.onclick = function() { setMode('persp'); };
    }

    // Couleur stable par vue (plusieurs vues distinguables sur la carte)
    function _vsViewColor(id) {
        var h = 0, s = String(id || '');
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
        return 'hsl(' + h + ',62%,42%)';
    }
    // Ajoute une vue sur la carte SANS retirer les autres (affichage multiple)
    function _vsAddToMap(v, focus) {
        var map = findLeafletMap();
        if (!map) return;
        if (_vsShownLayers[v.id]) {
            if (focus && v.bounds) { try { map.fitBounds(v.bounds, { padding: [20, 20] }); } catch(_e) {} }
            return;
        }
        var col = _vsViewColor(v.id);
        var g = L.layerGroup().addTo(map);
        if (v.planiURL && v.bounds) {
            // Meme opacite (0.85) ET rendu pixelise que _vsRenderPlani pour
            // qu'une vue revue soit representee exactement comme a sa creation.
            _vsInjectOverlayStyle();
            L.imageOverlay(v.planiURL, v.bounds, { opacity: 0.85, interactive: false,
                className: 'pwa-vs-overlay' }).addTo(g);
        }
        L.circleMarker([v.lat, v.lon], {
            radius: 6, color: '#fff', weight: 2, fillColor: col, fillOpacity: 1
        }).bindPopup('<b>' + escapeHtml(v.name || 'Vue') + '</b><br>Observation sol ~'
            + v.obsElev + ' m (+' + v.obsH + ' m)').addTo(g);
        (v.targets || []).forEach(function(t) {
            L.circleMarker([t.lat, t.lon], {
                radius: 5, weight: 2, color: '#fff',
                fillColor: t.visible ? '#1e8449' : '#7f8c8d', fillOpacity: 1
            }).bindPopup((t.name || 'Point') + '<br>' + (t.visible ? 'VISIBLE' : 'masque')
                + ' · ' + t.dist + ' m').addTo(g);
        });
        (v.peaks || []).forEach(function(p) {
            L.circleMarker([p.lat, p.lon], {
                radius: 4, weight: 2, color: '#fff',
                fillColor: p.visible ? '#8a5a2b' : '#9aa3a3', fillOpacity: 1
            }).bindPopup('▲ ' + escapeHtml(p.name) + (p.elev ? '<br>' + p.elev + ' m' : '')
                + '<br>' + (p.visible ? 'VISIBLE' : 'masque') + ' · '
                + Math.round(p.dist) + ' m').addTo(g);
        });
        (v.patrimoine || []).forEach(function(p) {
            L.marker([p.lat, p.lon], {
                icon: _vsDiamondIcon(p.visible ? '#e8458f' : '#cf8fb5')
            }).bindPopup('◆ ' + escapeHtml(p.name)
                + (p.nature ? '<br>' + escapeHtml(p.nature) : '')
                + '<br>' + (p.visible ? 'VISIBLE' : 'masque') + ' · '
                + Math.round(p.dist) + ' m').addTo(g);
        });
        _vsShownLayers[v.id] = g;
        if (focus && v.bounds) { try { map.fitBounds(v.bounds, { padding: [20, 20] }); } catch(_e) {} }
    }
    function _vsRemoveFromMap(id) {
        var map = findLeafletMap(), g = _vsShownLayers[id];
        if (g && map) { try { map.removeLayer(g); } catch(_e) {} }
        delete _vsShownLayers[id];
    }
    // Re-affiche une vue : l'ajoute sur la carte (sans masquer les autres) + panorama
    function _vsShowSaved(v) {
        _vsAddToMap(v, true);
        if (v.panoramaURL) _vsResultModal(v);
    }

    function _vsManager() {
        var m = document.createElement('div');
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100065;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);
        m.innerHTML =
            '<div style="background:#fff;border-radius:12px;max-width:480px;width:100%;max-height:85vh;display:flex;flex-direction:column;padding:18px 20px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
            '<h2 style="margin:0;font-size:16px;color:#5a3a1a;">Vues enregistrees</h2>' +
            '<button id="pwaVMx" style="background:none;border:none;font-size:22px;cursor:pointer;color:#8b7355;">&times;</button>' +
            '</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">' +
            '<button id="pwaVMnew" style="background:#8b4513;color:#fff;border:none;padding:9px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">Nouveau champ de visibilite</button>' +
            '<button id="pwaVMall" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:9px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">Tout afficher</button>' +
            '<button id="pwaVMnone" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:9px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI;">Tout masquer</button>' +
            '</div>' +
            '<div style="font-size:11px;color:#999;margin-bottom:8px;">Cocher « Sur la carte » pour superposer plusieurs vues simultanement.</div>' +
            '<div id="pwaVMlist" style="flex:1;overflow-y:auto;border:1px solid #f0ebe3;border-radius:6px;padding:6px;min-height:100px;max-height:52vh;font-size:13px;">Chargement...</div>' +
            '</div>';
        if (typeof L !== 'undefined' && L.DomEvent) { L.DomEvent.disableClickPropagation(m); L.DomEvent.disableScrollPropagation(m); }
        function close() { m.remove(); }
        m.querySelector('#pwaVMx').onclick = close;
        m.onclick = function(e) { if (e.target === m) close(); };
        m.querySelector('#pwaVMnew').onclick = function() { close(); _vsStart(); };
        var listEl = m.querySelector('#pwaVMlist');
        var curPid = (window.DRAWING_PROJET_ID || window.PROJET_ID || null);
        function refresh() {
            _vsDbAll().then(function(vs) {
                vs.sort(function(a, b) { return (b.date || 0) - (a.date || 0); });
                if (!vs.length) {
                    listEl.innerHTML = '<div style="color:#999;font-style:italic;padding:10px;text-align:center;">Aucune vue enregistree.</div>';
                    return;
                }
                listEl.innerHTML = vs.map(function(v) {
                    var nv = (v.targets || []).filter(function(t) { return t.visible; }).length;
                    var on = !!_vsShownLayers[v.id];
                    var col = _vsViewColor(v.id);
                    var otherProj = (v.projet_id != null && curPid != null
                        && String(v.projet_id) !== String(curPid));
                    return '<div style="border-bottom:1px solid #f4efe7;padding:8px 6px;">' +
                        '<div style="display:flex;align-items:center;gap:6px;">' +
                        '<span style="width:10px;height:10px;border-radius:50%;background:' + col + ';flex:0 0 auto;"></span>' +
                        '<span style="font-weight:600;color:#5a3a1a;">' + escapeHtml(v.name || v.id) + '</span>' +
                        (otherProj ? '<span style="font-size:10px;color:#b06a2b;border:1px solid #e6cdb4;border-radius:4px;padding:0 4px;">autre projet</span>' : '') +
                        '</div>' +
                        '<div style="color:#999;font-size:11px;margin:2px 0 6px;">rayon ' + (v.radiusM / 1000)
                        + ' km · ' + (v.full ? '360 deg' : ('secteur ' + v.azW + ' deg')) + ' · '
                        + (v.targets ? v.targets.length : 0) + ' pts (' + nv + ' vis.)'
                        + ((v.peaks && v.peaks.length) ? ' · ' + v.peaks.length + ' sommets' : '')
                        + ' · ' + new Date(v.date).toLocaleDateString('fr-FR') + '</div>' +
                        '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' +
                        '<label style="display:inline-flex;align-items:center;gap:4px;font:600 11px Segoe UI;color:#5a3a1a;cursor:pointer;">' +
                        '<input type="checkbox" class="pwaVMon" data-id="' + v.id + '"' + (on ? ' checked' : '') + '> Sur la carte</label>' +
                        '<button class="pwaVMshow" data-id="' + v.id + '" style="background:#f0ebe3;color:#5a3a1a;border:none;border-radius:6px;padding:5px 9px;font:600 11px Segoe UI;cursor:pointer;">Revoir</button>' +
                        '<button class="pwaVMren" data-id="' + v.id + '" style="background:#f0ebe3;color:#5a3a1a;border:none;border-radius:6px;padding:5px 9px;font:600 11px Segoe UI;cursor:pointer;">Renommer</button>' +
                        '<button class="pwaVMdel" data-id="' + v.id + '" style="background:#fff;color:#c0392b;border:1px solid #e8c8c4;border-radius:6px;padding:5px 9px;font:600 11px Segoe UI;cursor:pointer;">Supprimer</button>' +
                        '</div></div>';
                }).join('');
                listEl.querySelectorAll('.pwaVMon').forEach(function(c) {
                    c.onchange = function() {
                        _vsDbGet(c.dataset.id).then(function(v) {
                            if (!v) return;
                            if (c.checked) _vsAddToMap(v, false); else _vsRemoveFromMap(v.id);
                        });
                    };
                });
                listEl.querySelectorAll('.pwaVMshow').forEach(function(b) {
                    b.onclick = function() { _vsDbGet(b.dataset.id).then(function(v) { if (v) { close(); _vsShowSaved(v); } }); };
                });
                listEl.querySelectorAll('.pwaVMren').forEach(function(b) {
                    b.onclick = function() {
                        _vsDbGet(b.dataset.id).then(function(v) {
                            if (!v) return;
                            var nn = prompt('Nom :', v.name);
                            if (nn && nn.trim()) { v.name = nn.trim(); _vsDbPut(v).then(refresh); }
                        });
                    };
                });
                listEl.querySelectorAll('.pwaVMdel').forEach(function(b) {
                    b.onclick = function() {
                        if (!confirm('Supprimer cette vue ?')) return;
                        _vsRemoveFromMap(b.dataset.id);
                        _vsDbDel(b.dataset.id).then(refresh);
                    };
                });
            });
        }
        m.querySelector('#pwaVMall').onclick = function() {
            _vsDbAll().then(function(vs) { vs.forEach(function(v) { _vsAddToMap(v, false); }); refresh(); });
        };
        m.querySelector('#pwaVMnone').onclick = function() {
            Object.keys(_vsShownLayers).forEach(_vsRemoveFromMap); refresh();
        };
        refresh();
    }

    function _vsClear() {
        var map = findLeafletMap();
        if (_vsLayer && map) { try { map.removeLayer(_vsLayer); } catch(_e) {} }
        _vsLayer = null;
        Object.keys(_vsShownLayers).forEach(_vsRemoveFromMap);
    }
    window._pwaViewshed = _vsStart;
    window._pwaViewshedSaved = _vsManager;
    window._pwaViewshedClear = _vsClear;

    // Refresh badge si on entre/sort du fullscreen (re-parenter au bon contexte)
    document.addEventListener('fullscreenchange', function() {
        var b = document.getElementById('pwaStatusBadge');
        if (b) { b.remove(); }
        var pb = document.getElementById('pwaPosBtn');
        if (pb) { pb.remove(); }
        var pm = document.getElementById('pwaPosMenu');
        if (pm) { pm.remove(); }
        setTimeout(updateStatusBadge, 100);
    });

    function updateStatusBadge() {
        var b = ensureBadge();
        _ensurePosBtn();
        var online = !isAppOffline();
        var forced = isForcedOffline();
        b.style.color = online ? '#2e7d32' : '#c62828';
        var dotColor = online ? '#43a047' : (forced ? '#9b59b6' : '#e53935');
        var dot = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + dotColor + '"></span>';
        var label = online ? 'En ligne' : (forced ? 'Hors ligne (test)' : 'Hors ligne');
        // Petit bouton icone "actualiser" a droite du statut, separe par un trait.
        // stopPropagation au click pour ne PAS ouvrir le menu hors-ligne.
        var reloadBtn =
            '<span style="width:1px;height:14px;background:#ddd;margin:0 2px;flex:none;"></span>' +
            '<button id="pwaReloadBtn" title="Actualiser la page" ' +
            'style="display:flex;align-items:center;justify-content:center;' +
            'width:22px;height:22px;padding:0;border:none;border-radius:50%;flex:none;' +
            'background:transparent;color:' + (online ? '#2e7d32' : '#c62828') + ';' +
            'cursor:pointer;-webkit-tap-highlight-color:transparent;">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
            '<path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>' +
            '</svg></button>';
        b.innerHTML = dot + '<span>' + label + '</span> <span id="pwaQueueCount"></span>' + reloadBtn;
        var rb = document.getElementById('pwaReloadBtn');
        if (rb) {
            rb.onclick = function(e) {
                e.stopPropagation();
                e.preventDefault();
                location.reload();
            };
            // Empecher aussi le mousedown/touchstart de remonter au badge
            rb.addEventListener('mousedown', function(e) { e.stopPropagation(); });
            rb.addEventListener('touchstart', function(e) { e.stopPropagation(); }, { passive: true });
        }
        updateQueueBadge();
    }

    function updateQueueBadge() {
        var span = document.getElementById('pwaQueueCount');
        if (!span) return;
        dbAll().then(function(items) {
            if (items.length > 0) {
                span.style.cssText = 'background:#ff7043;color:#fff;padding:1px 6px;border-radius:8px;font-size:10px;';
                span.textContent = '• ' + items.length + ' en attente';
            } else {
                span.textContent = '';
            }
        });
    }

    // ===== Modal menu offline =====
    function openOfflineMenu() {
        var existing = document.getElementById('pwaMenuModal');
        if (existing) { existing.remove(); return; }
        var m = document.createElement('div');
        m.id = 'pwaMenuModal';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10500;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);
        // Ton DISCRET, meme palette brun/creme/olive. Hierarchie conservee :
        // les actions auparavant en couleur foncee (primary/accent) restent
        // mises en avant via un fond creme plus chaud + texte plus appuye ;
        // les autres en creme tres clair.
        var _bbase = 'padding:9px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI,sans-serif;text-align:left;width:100%;transition:background 0.15s;';
        // Emphase (ex-#8b4513) : fond creme chaud, bordure ambree, texte appuye
        var btnPrimary = 'background:#efe1cd;color:#5a3a1a;border:1px solid #d8c2a0;font-weight:700;' + _bbase;
        // Secondaire : creme tres clair
        var btnSecondary = 'background:#f7f3ec;color:#5a3a1a;border:1px solid #e3dac8;' + _bbase;
        // Accent (ex-#5a3a1a, le plus fonce) : meme emphase que primary
        var btnAccent = btnPrimary;
        // Danger : rouge sobre, fond clair
        var btnDanger = 'background:#fcf1ef;color:#c0392b;border:1px solid #e8c8c4;' + _bbase;
        // Test : actif = teal doux ; inactif = secondaire discret
        var btnTest = isForcedOffline()
            ? 'background:#e6f4f0;color:#0e7a68;border:1px solid #bfe3da;' + _bbase
            : 'background:#f7f3ec;color:#5a3a1a;border:1px solid #e3dac8;' + _bbase;
        var sectionTitle = 'font:700 10px Segoe UI,sans-serif;text-transform:uppercase;letter-spacing:0.6px;color:#8b7355;margin:14px 0 6px 2px;border-bottom:1px solid #f0ebe3;padding-bottom:4px;';

        m.innerHTML =
            '<div style="background:#fff;border-radius:10px;max-width:480px;width:100%;max-height:88vh;overflow-y:auto;padding:20px 22px;box-shadow:0 4px 24px rgba(0,0,0,0.3);">' +

            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
            '<h2 style="margin:0;font-size:17px;color:#5a3a1a;font-family:Segoe UI,sans-serif;">Mode hors-ligne</h2>' +
            '<button id="pwaMClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:#8b7355;line-height:1;padding:0 4px;">&times;</button>' +
            '</div>' +

            '<div id="pwaMStats" style="font-size:11px;color:#5a3a1a;background:#faf7f2;padding:9px 11px;border-radius:6px;margin-bottom:8px;border:1px solid #f0ebe3;line-height:1.5;">Chargement des statistiques...</div>' +

            // Section : INSTALLATION
            '<div style="' + sectionTitle + '">Installation</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;">' +
            '<button id="pwaMInstall" style="' + btnPrimary + '">Installer cette carte sur l\'ecran d\'accueil</button>' +
            '</div>' +

            // Section : HORS-LIGNE
            '<div style="' + sectionTitle + '">Donnees hors-ligne</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;">' +
            '<button id="pwaMPrecache" style="' + btnPrimary + '">Pre-charger ou ajuster une zone</button>' +
            '<button id="pwaMShowZone" style="' + btnSecondary + '">' +
                (isPrecachedZoneVisible() ? 'Masquer la zone hors-ligne sur la carte' :
                 (getStoredZone() ? 'Afficher la zone hors-ligne sur la carte' : 'Aucune zone hors-ligne enregistree')) +
            '</button>' +
            '<button id="pwaMClear" style="' + btnSecondary + '">Consulter / gerer le cache hors-ligne</button>' +
            '</div>' +

            // Position & parcours : regroupes dans la fenetre du bouton Position
            // (flottant, au-dessus du badge). Plus de doublon dans ce menu.

            // Section : SYNCHRONISATION
            '<div style="' + sectionTitle + '">Synchronisation</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;">' +
            '<button id="pwaMQueue" style="' + btnAccent + '">Voir les modifications en attente</button>' +
            '<button id="pwaMReplay" style="' + btnSecondary + '">Forcer la synchronisation</button>' +
            '<button id="pwaMSimOffline" style="' + btnTest + '">' +
                (isForcedOffline() ? 'Quitter le mode test hors-ligne' : 'Activer le mode test hors-ligne') +
            '</button>' +
            '</div>' +

            // Section : MAINTENANCE
            '<div style="' + sectionTitle + '">Maintenance</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;">' +
            '<button id="pwaMReload" style="' + btnSecondary + '">Actualiser la page</button>' +
            '<button id="pwaMUpdate" style="' + btnSecondary + '">Forcer la mise a jour PWA</button>' +
            '</div>' +

            '</div>';
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(m);
            L.DomEvent.disableScrollPropagation(m);
        }
        document.getElementById('pwaMClose').onclick = function() { m.remove(); };
        m.onclick = function(e) { if (e.target === m) m.remove(); };

        // Stats
        getCacheStats().then(function(s) {
            var statsEl = document.getElementById('pwaMStats');
            if (!statsEl) return;
            if (!s) { statsEl.textContent = 'Service Worker non actif. Recharge la page en HTTPS.'; return; }
            statsEl.innerHTML =
                '<strong>Cache local (' + s.version + ')</strong><br>' +
                'Tuiles : ' + s.tiles + '<br>' +
                (s.context ? 'Contexte Corse (installe) : ' + s.context + ' tuiles<br>' : '') +
                'Photos : ' + s.photos + '<br>' +
                'API : ' + s.api + '<br>' +
                'Cartes HTML : ' + s.html;
        });

        document.getElementById('pwaMInstall').onclick = function() { m.remove(); openInstallFlow(); };
        document.getElementById('pwaMPrecache').onclick = function() { m.remove(); openPrecacheModal(); };
        document.getElementById('pwaMShowZone').onclick = function() {
            m.remove();
            if (isPrecachedZoneVisible()) {
                hidePrecachedZoneOnMap();
                _setZoneHidden(true);  // memorise : ne plus afficher au reload
                showToast('Zone hors-ligne masquee (ne reapparaitra plus au rechargement).');
            } else if (getStoredZone()) {
                _setZoneHidden(false);  // memorise : reafficher au reload
                showPrecachedZoneOnMap(false);
                showToast('Zone hors-ligne affichee. Restera visible au rechargement (en ligne et hors-ligne).', 5000);
            } else {
                showToast('Aucune zone pre-cachee. Utilise "Pre-charger une zone" d\'abord.');
            }
        };
        document.getElementById('pwaMQueue').onclick = function() { m.remove(); openQueueDetailsModal(); };
        document.getElementById('pwaMReplay').onclick = function() {
            if (isAppOffline()) { showToast('Pas de connexion reseau (ou mode test active)'); return; }
            replayQueue().then(function() { showToast('Synchro terminee'); m.remove(); });
        };
        document.getElementById('pwaMSimOffline').onclick = function() {
            var newState = !isForcedOffline();
            setForcedOffline(newState);
            updateStatusBadge();
            m.remove();
            showToast(newState
                ? 'Mode test hors-ligne ACTIVE. Tes modifs iront en queue.'
                : 'Mode test desactive. Retour en mode normal.', 5000);
            // Si on revient en ligne et qu'il y a des items en queue, replay auto
            if (!newState && navigator.onLine) setTimeout(autoReplay, 500);
        };
        document.getElementById('pwaMReload').onclick = function() {
            m.remove();
            location.reload();
        };
        document.getElementById('pwaMUpdate').onclick = function() {
            if (!confirm('Forcer une mise a jour PWA ? Le cache et le Service Worker seront supprimes, la page rechargee avec la derniere version. Tu auras besoin de reseau au prochain demarrage.')) return;
            m.remove();
            // 1. Desinstaller tous les SW
            var swPromise = navigator.serviceWorker && navigator.serviceWorker.getRegistrations
                ? navigator.serviceWorker.getRegistrations().then(function(regs) {
                    return Promise.all(regs.map(function(r) { return r.unregister(); }));
                  })
                : Promise.resolve();
            // 2. Vider les caches SAUF le contexte Corse installe (cher a
            //    retelecharger) : une MAJ PWA rafraichit le code, pas les
            //    donnees hors-ligne de l'utilisateur.
            var cachePromise = 'caches' in window
                ? caches.keys().then(function(keys) {
                    return Promise.all(keys
                        .filter(function(k) { return k !== 'corse-context'; })
                        .map(function(k) { return caches.delete(k); }));
                  })
                : Promise.resolve();
            Promise.all([swPromise, cachePromise]).then(function() {
                // flag contexte Corse CONSERVE (le cache CTX n'a pas ete vide)
                showToast('Mise a jour : rechargement (contexte Corse conserve)...');
                setTimeout(function() { location.reload(true); }, 800);
            });
        };
        document.getElementById('pwaMClear').onclick = function() {
            m.remove();
            openCacheManageModal();  // choix selectif par DL lance
        };
    }

    // ===== Helpers : selection par commune (Corse 2A/2B) =====
    // Source : geo.api.gouv.fr (API publique gratuite, contours officiels IGN).
    // Liste des ~360 communes 2A/2B mise en cache localStorage 30j.
    var _communesCorseCache = null;
    function loadCommunesCorse() {
        if (_communesCorseCache && _communesCorseCache.length > 0) {
            return Promise.resolve(_communesCorseCache);
        }
        // Cache localStorage (uniquement si non vide, sinon ignore et re-fetch)
        try {
            var stored = localStorage.getItem('pwaCommunesCorse');
            if (stored) {
                var parsed = JSON.parse(stored);
                if (parsed.ts && parsed.data && parsed.data.length > 0
                        && (Date.now() - parsed.ts < 30 * 24 * 3600 * 1000)) {
                    _communesCorseCache = parsed.data;
                    return Promise.resolve(parsed.data);
                }
            }
        } catch(_e) {}
        // L'API geo.api.gouv.fr ne supporte PAS codeDepartement=2A,2B (renvoie []).
        // On doit fetch les 2 departements separement puis fusionner.
        var url2A = 'https://geo.api.gouv.fr/communes?codeDepartement=2A&fields=code,nom,centre&format=json';
        var url2B = 'https://geo.api.gouv.fr/communes?codeDepartement=2B&fields=code,nom,centre&format=json';
        function fetchDep(u) {
            return fetch(u)
                .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status + ' (' + u + ')'); return r.json(); });
        }
        return Promise.all([fetchDep(url2A), fetchDep(url2B)]).then(function(parts) {
            var data = (parts[0] || []).concat(parts[1] || []);
            if (data.length === 0) throw new Error('Liste vide (API en panne ?)');
            data.sort(function(a, b) { return a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' }); });
            _communesCorseCache = data;
            try { localStorage.setItem('pwaCommunesCorse', JSON.stringify({ ts: Date.now(), data: data })); } catch(_e) {}
            return data;
        });
    }

    function fetchCommuneContour(code) {
        return fetch('https://geo.api.gouv.fr/communes/' + code + '?geometry=contour&format=geojson')
            .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }

    // Normalise un texte pour la recherche (sans accents, lowercase)
    function _normalize(s) {
        return (s || '').toString().toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '');
    }

    // Convertit un GeoJSON Polygon/MultiPolygon en tableau de polygones [lat,lng][][]
    function geoJsonToLatLngs(geom) {
        if (!geom) return [];
        var polys = [];
        function ringToLatLngs(ring) {
            return ring.map(function(c) { return [c[1], c[0]]; });  // GeoJSON = [lng,lat]
        }
        if (geom.type === 'Polygon') {
            polys.push(geom.coordinates.map(ringToLatLngs));
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(function(poly) {
                polys.push(poly.map(ringToLatLngs));
            });
        }
        return polys;
    }

    // Modal de selection des communes corses (recherche + checkboxes).
    // Au clic sur "Valider", fetch les contours, calcule la bbox combinee,
    // puis ouvre openPrecacheModal avec ces bounds + memorise les polygones.
    function openCommuneSelector(map) {
        var m = document.createElement('div');
        m.id = 'pwaCommuneModal';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10500;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);

        m.innerHTML =
            '<div style="background:#fff;border-radius:10px;max-width:480px;width:100%;max-height:90vh;display:flex;flex-direction:column;padding:20px 24px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
            '<h2 style="margin:0;font-size:17px;color:#5a3a1a;">Selection par commune</h2>' +
            '<button id="pwaCCancel" style="background:none;border:none;font-size:22px;cursor:pointer;color:#8b7355;">&times;</button>' +
            '</div>' +
            '<input id="pwaCSearch" type="search" placeholder="Rechercher une commune" style="width:100%;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:13px;margin-bottom:10px;box-sizing:border-box;">' +
            '<div id="pwaCStatus" style="font-size:11px;color:#999;margin-bottom:6px;">Chargement...</div>' +
            '<div id="pwaCList" style="flex:1;overflow-y:auto;border:1px solid #f0ebe3;border-radius:6px;padding:6px;min-height:200px;max-height:50vh;font-size:13px;"></div>' +
            '<div id="pwaCSelected" style="font-size:11px;color:#5a3a1a;margin-top:8px;min-height:18px;"></div>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">' +
            '<button id="pwaCCancel2" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Annuler</button>' +
            '<button id="pwaCValidate" style="background:#8b4513;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;" disabled>Valider</button>' +
            '</div>' +
            '</div>';
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(m);
            L.DomEvent.disableScrollPropagation(m);
        }

        var selectedCodes = {};
        var listEl = m.querySelector('#pwaCList');
        var searchEl = m.querySelector('#pwaCSearch');
        var statusEl = m.querySelector('#pwaCStatus');
        var selEl = m.querySelector('#pwaCSelected');
        var validateBtn = m.querySelector('#pwaCValidate');
        var allCommunes = [];

        function renderList(filter) {
            var q = _normalize(filter);
            var items = q ? allCommunes.filter(function(c) {
                return _normalize(c.nom).indexOf(q) !== -1 || c.code.toLowerCase().indexOf(q) !== -1;
            }) : allCommunes;
            if (items.length === 0) {
                listEl.innerHTML = '<div style="color:#999;font-style:italic;padding:8px;text-align:center;">Aucun resultat.</div>';
                return;
            }
            var MAX = 200;  // limite affichage pour perf
            var slice = items.slice(0, MAX);
            listEl.innerHTML = slice.map(function(c) {
                var checked = selectedCodes[c.code] ? ' checked' : '';
                return '<label style="display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;border-radius:3px;" onmouseover="this.style.background=\'#faf7f2\'" onmouseout="this.style.background=\'transparent\'">' +
                    '<input type="checkbox" class="pwaCCb" data-code="' + c.code + '"' + checked + '>' +
                    '<span style="flex:1;">' + escapeHtml(c.nom) + '</span>' +
                    '<span style="color:#999;font-size:10px;font-family:monospace;">' + c.code + '</span>' +
                    '</label>';
            }).join('') + (items.length > MAX
                ? '<div style="color:#999;font-style:italic;font-size:11px;padding:6px;text-align:center;">... et ' + (items.length - MAX) + ' autres. Affine la recherche.</div>'
                : '');
            listEl.querySelectorAll('input.pwaCCb').forEach(function(cb) {
                cb.onchange = function() {
                    if (cb.checked) selectedCodes[cb.dataset.code] = true;
                    else delete selectedCodes[cb.dataset.code];
                    refreshSelected();
                };
            });
        }
        function refreshSelected() {
            var codes = Object.keys(selectedCodes);
            var n = codes.length;
            validateBtn.disabled = (n === 0);
            if (n === 0) {
                selEl.textContent = '';
                return;
            }
            var names = codes.map(function(code) {
                var c = allCommunes.find(function(x) { return x.code === code; });
                return c ? c.nom : code;
            });
            selEl.innerHTML = '<strong>' + n + ' commune' + (n > 1 ? 's' : '') + ' :</strong> ' + escapeHtml(names.slice(0, 5).join(', ')) + (n > 5 ? ' + ' + (n - 5) + ' autre(s)' : '');
        }

        loadCommunesCorse().then(function(data) {
            allCommunes = data;
            statusEl.textContent = data.length + ' communes (2A + 2B)';
            renderList('');
        }).catch(function(err) {
            statusEl.style.color = '#c0392b';
            statusEl.textContent = 'Erreur de chargement : ' + err.message + '. Re-essaye plus tard.';
            listEl.innerHTML = '<div style="color:#c0392b;padding:8px;text-align:center;">Reseau requis pour charger la liste des communes.</div>';
        });

        var searchTimer = null;
        searchEl.oninput = function() {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function() { renderList(searchEl.value); }, 120);
        };

        function close() { m.remove(); }
        m.querySelector('#pwaCCancel').onclick = close;
        m.querySelector('#pwaCCancel2').onclick = function() {
            close();
            openPrecacheModal();
        };
        m.onclick = function(e) { if (e.target === m) close(); };

        validateBtn.onclick = function() {
            var codes = Object.keys(selectedCodes);
            if (codes.length === 0) return;
            validateBtn.disabled = true;
            validateBtn.textContent = 'Chargement contours...';
            statusEl.style.color = '#5a3a1a';
            statusEl.textContent = 'Telechargement des contours (' + codes.length + ')...';

            Promise.all(codes.map(function(c) {
                return fetchCommuneContour(c).catch(function(e) {
                    console.warn('[PWA] Contour ' + c + ' echoue:', e);
                    return null;
                });
            })).then(function(features) {
                var valid = features.filter(function(f) { return f && f.geometry; });
                if (valid.length === 0) {
                    statusEl.style.color = '#c0392b';
                    statusEl.textContent = 'Aucun contour recupere. Re-essaye plus tard.';
                    validateBtn.disabled = false;
                    validateBtn.textContent = 'Valider';
                    return;
                }
                // Calculer bbox globale
                var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
                var allPolys = [];
                valid.forEach(function(feat) {
                    var polys = geoJsonToLatLngs(feat.geometry);
                    allPolys.push({
                        code: feat.properties && feat.properties.code,
                        nom: feat.properties && feat.properties.nom,
                        polygons: polys
                    });
                    polys.forEach(function(poly) {
                        poly.forEach(function(ring) {
                            ring.forEach(function(pt) {
                                if (pt[0] < minLat) minLat = pt[0];
                                if (pt[0] > maxLat) maxLat = pt[0];
                                if (pt[1] < minLng) minLng = pt[1];
                                if (pt[1] > maxLng) maxLng = pt[1];
                            });
                        });
                    });
                });
                var bounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
                close();
                // Memoriser les polygones pour la visualisation
                _pendingCommunePolys = allPolys;
                openPrecacheModal(bounds);
            });
        };
    }

    // Polygones temporaires des communes choisies, utilises par openPrecacheModal
    // pour les afficher sur la carte (et eventuellement les stocker avec la zone).
    var _pendingCommunePolys = null;

    // ===== Modal pre-cache zone =====
    // bounds par defaut = zone visible courante. L'utilisateur peut basculer
    // sur "Dessiner manuellement" pour tracer un rectangle libre sur la carte,
    // ou sur "Selectionner une commune" pour piocher dans la liste 2A/2B.
    function openPrecacheModal(customBounds) {
        var map = findLeafletMap();
        if (!map) { alert('Carte non detectee.'); return; }
        var existingZone = getStoredZone();
        var bounds = customBounds || (existingZone ? L.latLngBounds(existingZone.bounds[0], existingZone.bounds[1]) : map.getBounds());
        var isCustom = !!customBounds;
        var curZoom = map.getZoom();
        // Defaults : si une zone existe deja, repartir de ses zooms ; sinon
        // valeurs par defaut min 14 / max 18.
        var minZ = existingZone ? existingZone.zmin : 14;
        var maxZ = existingZone ? existingZone.zmax : 18;
        // Afficher la zone existante sur la carte en arriere-plan pendant qu'on
        // ajuste, pour faciliter l'ajustement visuel.
        if (existingZone && !customBounds) showPrecachedZoneOnMap(true);

        var m = document.createElement('div');
        m.id = 'pwaPrecacheModal';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10500;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);

        var allLayers = listAvailableLayers(map);
        var allProjects = listAvailableProjects();
        // Si le contexte Corse a deja ete telecharge a l'installation, ne pas
        // le reproposer (les tuiles 8-10 sont communes a toutes les cartes du
        // meme domaine, donc deja en cache).
        var corseLvl = _getCorseContextLevel();

        var layersHtml = allLayers.length === 0
            ? '<div style="font-size:11px;color:#999;font-style:italic;">Aucune couche detectee</div>'
            : allLayers.map(function(L) {
                return '<label style="display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer;font-size:12px;">' +
                    '<input type="checkbox" class="pwaLayerCb" data-id="' + L.id + '"' + (L.active ? ' checked' : '') + '>' +
                    '<span>' + escapeHtml(L.name) + (L.active ? '' : ' <span style="color:#aaa;font-size:10px;">(inactif)</span>') + '</span>' +
                    '</label>';
            }).join('');

        var projectsHtml = allProjects.length === 0
            ? '<div style="font-size:11px;color:#999;font-style:italic;">Aucun projet detecte</div>'
            : allProjects.map(function(P) {
                return '<label style="display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer;font-size:12px;">' +
                    '<input type="checkbox" class="pwaProjectCb" data-id="' + P.id + '"' + (P.current ? ' checked' : '') + '>' +
                    '<span>' + escapeHtml(P.nom) + (P.current ? ' <span style="color:#16a085;font-size:10px;">(courant)</span>' : '') + '</span>' +
                    '</label>';
            }).join('');

        m.innerHTML =
            '<div style="background:#fff;border-radius:10px;max-width:560px;width:100%;max-height:90vh;overflow-y:auto;padding:20px 24px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
            '<h2 style="margin:0;font-size:17px;color:#5a3a1a;">Pre-charger une zone</h2>' +
            '<button id="pwaPCancel" style="background:none;border:none;font-size:22px;cursor:pointer;color:#8b7355;">&times;</button>' +
            '</div>' +

            '<div style="margin-bottom:14px;font-size:12px;color:#5a3a1a;">' +
            '<div style="font-weight:600;margin-bottom:6px;">Source de la zone :</div>' +
            '<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;">' +
            '<input type="radio" name="pwaZoneSrc" value="visible"' + (isCustom ? '' : ' checked') + '> Zone visible courante' +
            '</label>' +
            '<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;">' +
            '<input type="radio" name="pwaZoneSrc" value="draw"' + (isCustom && !_pendingCommunePolys ? ' checked' : '') + '> Dessiner manuellement un rectangle' +
            '</label>' +
            '<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;">' +
            '<input type="radio" name="pwaZoneSrc" value="commune"' + (_pendingCommunePolys ? ' checked' : '') + '> Selectionner une (ou plusieurs) commune(s) de Corse' +
            '</label>' +
            (_pendingCommunePolys ? '<div style="font-size:11px;color:#16a085;margin-top:4px;">' + _pendingCommunePolys.length + ' commune(s) selectionnee(s) : ' +
                escapeHtml(_pendingCommunePolys.map(function(p){return p.nom;}).slice(0,5).join(', ')) +
                (_pendingCommunePolys.length > 5 ? ' + ' + (_pendingCommunePolys.length - 5) + ' autre(s)' : '') + '</div>' : '') +
            (isCustom && !_pendingCommunePolys ? '<div style="font-size:11px;color:#16a085;margin-top:4px;">Rectangle defini : ' +
                bounds.getSouth().toFixed(3) + ',' + bounds.getWest().toFixed(3) + ' - ' +
                bounds.getNorth().toFixed(3) + ',' + bounds.getEast().toFixed(3) + '</div>' : '') +
            '</div>' +

            '<div style="display:flex;gap:10px;margin-bottom:14px;">' +
            '<label style="flex:1;font-size:12px;color:#5a3a1a;">Zoom min<br><input type="number" id="pwaZmin" min="6" max="20" value="' + minZ + '" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:4px;"></label>' +
            '<label style="flex:1;font-size:12px;color:#5a3a1a;">Zoom max<br><input type="number" id="pwaZmax" min="6" max="20" value="' + maxZ + '" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:4px;"></label>' +
            '</div>' +

            '<details open style="margin-bottom:14px;border:1px solid #f0ebe3;border-radius:6px;padding:6px 12px;">' +
            '<summary style="font-size:12px;color:#5a3a1a;font-weight:600;cursor:pointer;padding:4px 0;">Couches a pre-cacher (' + allLayers.filter(function(l){return l.active;}).length + '/' + allLayers.length + ' actives)</summary>' +
            '<div style="max-height:140px;overflow-y:auto;margin-top:6px;">' + layersHtml + '</div>' +
            '</details>' +

            '<details style="margin-bottom:14px;border:1px solid #f0ebe3;border-radius:6px;padding:6px 12px;">' +
            '<summary style="font-size:12px;color:#5a3a1a;font-weight:600;cursor:pointer;padding:4px 0;">Projets a pre-cacher (' + allProjects.filter(function(p){return p.current;}).length + '/' + allProjects.length + ')</summary>' +
            '<div style="max-height:140px;overflow-y:auto;margin-top:6px;">' + projectsHtml + '</div>' +
            '<div style="font-size:10px;color:#999;margin-top:4px;">Pour chaque projet coche : les features (points/polygones) et photos seront mis en cache pour consultation offline.</div>' +
            '</details>' +

            (corseLvl
                ? '<div style="display:flex;align-items:flex-start;gap:8px;font-size:12px;color:#16a085;margin-bottom:12px;background:#eafaf6;border:1px solid #b8e6da;border-radius:4px;padding:8px 10px;">' +
                  '<select id="pwaCorseCtx" style="display:none;"><option value="" selected></option></select>' +
                  '<span>Contexte Corse deja telecharge a l\'installation (' +
                  (corseLvl === 'full' ? 'fond complet zooms 8-14' : 'zooms 8-10') +
                  '). Inutile de le re-telecharger.</span>' +
                  '</div>'
                : '<label style="display:block;font-size:12px;color:#5a3a1a;margin-bottom:12px;">' +
                  'Contexte Corse (vue ile entiere hors-ligne)<br>' +
                  '<select id="pwaCorseCtx" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:4px;margin-top:3px;">' +
                  '<option value="" selected>Aucun</option>' +
                  '<option value="10">Leger — zooms 8-10 (~3 Mo)</option>' +
                  '<option value="14">Detaille — couches 8-14, Plan IGN 8-15 (~350 Mo)</option>' +
                  '</select></label>') +

            (_pendingCommunePolys
                ? ''  // selection commune : le nom est auto-derive des communes
                : '<label style="display:block;font-size:12px;color:#5a3a1a;margin-bottom:12px;">' +
                  'Nom de cette selection (pour la retrouver dans la liste)<br>' +
                  '<input type="text" id="pwaPName" maxlength="50" placeholder="Nom de la selection" ' +
                  'style="width:100%;padding:7px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;margin-top:3px;"></label>') +

            '<div id="pwaPEstim" style="font-size:11px;color:#666;background:#faf7f2;padding:8px;border-radius:4px;margin-bottom:12px;"></div>' +
            '<div id="pwaPProgress" style="display:none;margin-bottom:12px;"><div style="background:#eee;border-radius:4px;overflow:hidden;height:20px;"><div id="pwaPBar" style="background:#8b4513;height:100%;width:0%;transition:width 0.2s;"></div></div><div id="pwaPLabel" style="font-size:11px;color:#666;margin-top:4px;text-align:center;">0%</div></div>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
            '<button id="pwaPCancel2" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Annuler</button>' +
            '<button id="pwaPStart" style="background:#8b4513;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Telecharger</button>' +
            '</div>' +
            '</div>';
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(m);
            L.DomEvent.disableScrollPropagation(m);
        }

        function getCheckedLayers() {
            var urls = [];
            m.querySelectorAll('input.pwaLayerCb:checked').forEach(function(cb) {
                var id = parseInt(cb.dataset.id);
                var item = allLayers.find(function(L) { return L.id === id; });
                if (item) urls.push(item.url);
            });
            return urls;
        }
        function getCheckedProjects() {
            var ids = [];
            m.querySelectorAll('input.pwaProjectCb:checked').forEach(function(cb) {
                ids.push(cb.dataset.id);
            });
            return ids;
        }

        function updateEstim() {
            var zmin = parseInt(document.getElementById('pwaZmin').value);
            var zmax = parseInt(document.getElementById('pwaZmax').value);
            if (zmin > zmax) { document.getElementById('pwaPEstim').textContent = 'zoom min > zoom max'; return; }
            var totalT = 0;
            for (var z = zmin; z <= zmax; z++) {
                var nb = bounds.getNorth(), sb = bounds.getSouth();
                var wb = bounds.getWest(), eb = bounds.getEast();
                var n = Math.pow(2, z);
                var xmin = Math.floor((wb + 180) / 360 * n);
                var xmax = Math.floor((eb + 180) / 360 * n);
                var ymin = Math.floor((1 - Math.log(Math.tan(nb * Math.PI / 180) + 1 / Math.cos(nb * Math.PI / 180)) / Math.PI) / 2 * n);
                var ymax = Math.floor((1 - Math.log(Math.tan(sb * Math.PI / 180) + 1 / Math.cos(sb * Math.PI / 180)) / Math.PI) / 2 * n);
                totalT += (Math.abs(xmax - xmin) + 1) * (Math.abs(ymax - ymin) + 1);
            }
            var nLayers = getCheckedLayers().length;
            var _ctxSel = document.getElementById('pwaCorseCtx');
            var corseCtxZmax = _ctxSel ? (parseInt(_ctxSel.value, 10) || 0) : 0;
            var includeCorse = corseCtxZmax > 0;
            // Estimation tuiles contexte Corse selon le zmax (par couche,
            // cumul 8..zmax, croissance ~x4 par niveau) :
            var corseTilesPerLayer = !includeCorse ? 0
                : (corseCtxZmax >= 14 ? 4300 : corseCtxZmax >= 13 ? 1300
                   : corseCtxZmax >= 12 ? 350 : corseCtxZmax >= 11 ? 90 : 25);
            // + Plan IGN pousse a z15 sur la Corse (detaille) : ~12800 tuiles
            var corseTiles = corseTilesPerLayer * nLayers
                + (corseCtxZmax >= 14 ? 12800 : 0);
            var totalTiles = totalT * nLayers + corseTiles;
            var nProjects = getCheckedProjects().length;
            var estMo = (totalTiles * 0.04).toFixed(1);

            // Estimation du temps : ~10 tuiles/sec en 4G avec parallelisme x8 SW
            // (debit reel limite par le serveur tuile, pas par la bande passante).
            // Si online : utiliser ~12 tuiles/s ; si reseau lent (Save-Data) : ~5/s.
            var rate = 10;
            if (navigator.connection) {
                if (navigator.connection.saveData) rate = 5;
                else if (navigator.connection.effectiveType === '4g') rate = 12;
                else if (navigator.connection.effectiveType === '3g') rate = 4;
                else if (navigator.connection.effectiveType === '2g') rate = 1;
            }
            var seconds = Math.ceil(totalTiles / rate);
            var timeStr;
            if (seconds < 60) timeStr = '~' + seconds + ' s';
            else if (seconds < 3600) timeStr = '~' + Math.ceil(seconds / 60) + ' min';
            else timeStr = '~' + (seconds / 3600).toFixed(1) + ' h';

            var summary = '<strong>' + totalTiles + ' tuiles</strong> · ~' + estMo + ' Mo · ' + nLayers + ' couche(s)';
            if (includeCorse) summary += ' + contexte Corse';
            summary += '<br><strong>Duree estimee : ' + timeStr + '</strong>';
            summary += ' <span style="color:#999;">(' + rate + ' tuiles/s)</span>';
            if (nProjects > 0) {
                summary += '<br>+ <strong>' + nProjects + ' projet(s)</strong> (data + photos, +qq sec a +qq min selon volume)';
            }
            document.getElementById('pwaPEstim').innerHTML = summary;
            m._cache = {
                zmin: zmin, zmax: zmax, totalAll: totalTiles, includeCorse: includeCorse,
                corseCtxZmax: corseCtxZmax,
                layerUrls: getCheckedLayers(), projectIds: getCheckedProjects()
            };
        }

        document.getElementById('pwaZmin').oninput = updateEstim;
        document.getElementById('pwaZmax').oninput = updateEstim;
        var _ctxSelEl = document.getElementById('pwaCorseCtx');
        if (_ctxSelEl) _ctxSelEl.onchange = updateEstim;
        m.querySelectorAll('input.pwaLayerCb').forEach(function(cb) { cb.onchange = updateEstim; });
        m.querySelectorAll('input.pwaProjectCb').forEach(function(cb) { cb.onchange = updateEstim; });
        function closeModal() {
            _pendingCommunePolys = null;  // purge la selection commune en attente
            m.remove();
        }
        document.getElementById('pwaPCancel').onclick = closeModal;
        document.getElementById('pwaPCancel2').onclick = closeModal;
        m.onclick = function(e) { if (e.target === m) closeModal(); };

        // Si user choisit "Dessiner" / "Commune", fermer modal et activer outil correspondant
        m.querySelectorAll('input[name="pwaZoneSrc"]').forEach(function(r) {
            r.onchange = function() {
                if (r.value === 'draw' && r.checked) {
                    _pendingCommunePolys = null;
                    m.remove();
                    activateRectangleDraw(map);
                } else if (r.value === 'commune' && r.checked) {
                    m.remove();
                    openCommuneSelector(map);
                } else if (r.value === 'visible' && r.checked) {
                    // Reset selection commune si on revient sur "visible"
                    if (_pendingCommunePolys) {
                        _pendingCommunePolys = null;
                        m.remove();
                        openPrecacheModal();
                    }
                }
            };
        });

        document.getElementById('pwaPStart').onclick = function() {
            var c = m._cache;
            if (!c) return;
            if (c.layerUrls.length === 0 && c.projectIds.length === 0) {
                alert('Coche au moins une couche ou un projet a pre-cacher.');
                return;
            }
            if (c.totalAll > 5000) {
                if (!confirm('Telecharger ' + c.totalAll + ' tuiles ? Ca peut prendre plusieurs minutes et utiliser ~' + (c.totalAll * 0.04).toFixed(0) + ' Mo de stockage.')) return;
            }
            // Nom personnalise (ignore pour une selection commune : auto-nom)
            var _nameEl = document.getElementById('pwaPName');
            var _label = (_nameEl && _nameEl.value.trim()) ? _nameEl.value.trim() : null;
            // Verif quota navigateur avant de lancer (~45 Ko/tuile, conservateur)
            var _estBytes = c.totalAll * 45000;
            _checkQuotaBeforeDownload(_estBytes).then(function(ok) {
                if (!ok) return;
                _requestPersistentStorage(false);
                startPrecache(map, bounds, c.zmin, c.zmax,
                    (c.corseCtxZmax || (c.includeCorse ? 10 : 0)),
                    c.layerUrls, c.projectIds, null, _label);
            });
        };

        updateEstim();
    }

    // ===== Outil : tracer un rectangle pour la zone a pre-cacher =====
    // Strategie : Leaflet.Draw a un mauvais support tactile sur smartphone
    // (gele souvent l'UI). On utilise donc TOUJOURS l'implementation native
    // sur mobile, et Leaflet.Draw uniquement sur desktop si dispo.
    function _isMobile() {
        return /Mobi|Android|iPhone|iPad|iPod|Touch/.test(navigator.userAgent)
            || ('ontouchstart' in window)
            || (navigator.maxTouchPoints > 0);
    }
    function activateRectangleDraw(map) {
        if (!map) {
            showToast('Carte Leaflet non detectee.', 5000);
            return;
        }
        if (!_isMobile() && typeof L !== 'undefined' && L.Draw && L.Draw.Rectangle) {
            return activateLeafletDrawRect(map);
        }
        return activateNativeRect(map);
    }

    function activateLeafletDrawRect(map) {
        var cancelBtn = showDrawCancelButton(function() {
            drawer.disable();
            map.off(L.Draw.Event.CREATED, onCreated);
            document.removeEventListener('keydown', onEsc);
            openPrecacheModal();
        });
        var drawer = new L.Draw.Rectangle(map, {
            shapeOptions: { color: '#8b4513', weight: 2, fillOpacity: 0.15 }
        });
        drawer.enable();
        function onCreated(e) {
            map.off(L.Draw.Event.CREATED, onCreated);
            hideDrawCancelButton();
            document.removeEventListener('keydown', onEsc);
            var layer = e.layer;
            map.addLayer(layer);
            var b = layer.getBounds();
            setTimeout(function() { map.removeLayer(layer); }, 200);
            openPrecacheModal(b);
        }
        function onEsc(e) {
            if (e.key === 'Escape') {
                drawer.disable();
                map.off(L.Draw.Event.CREATED, onCreated);
                document.removeEventListener('keydown', onEsc);
                hideDrawCancelButton();
                openPrecacheModal();
            }
        }
        map.once(L.Draw.Event.CREATED, onCreated);
        document.addEventListener('keydown', onEsc);
    }

    function showDrawCancelButton(onCancel) {
        var existing = document.getElementById('pwaDrawCancel');
        if (existing) existing.remove();
        var b = document.createElement('button');
        b.id = 'pwaDrawCancel';
        b.textContent = 'Annuler le dessin';
        b.style.cssText =
            'position:fixed;top:60px;left:50%;transform:translateX(-50%);' +
            'z-index:100070;background:#e74c3c;color:#fff;border:none;' +
            'padding:10px 20px;border-radius:22px;font:600 13px Segoe UI,sans-serif;' +
            'cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.25);';
        b.onclick = function() {
            hideDrawCancelButton();
            if (typeof onCancel === 'function') onCancel();
        };
        (document.body || document.documentElement).appendChild(b);
        return b;
    }

    function hideDrawCancelButton() {
        var b = document.getElementById('pwaDrawCancel');
        if (b) b.remove();
    }

    // Implementation 2-clics : comme le dessin de polygone Leaflet.Draw.
    // Tap 1 = premier coin du rectangle, tap 2 = coin oppose.
    // Bien plus fiable sur mobile que le drag (pas de probleme de touchstart/move).
    // La carte reste navigable entre les 2 taps (pan/zoom OK).
    function activateNativeRect(map) {
        var firstCorner = null;
        var rectLayer = null;
        var firstMarker = null;
        var bannerEl = null;

        showDrawCancelButton(function() {
            cleanup();
            openPrecacheModal();
        });
        showInfoBanner('Tap 1 sur la carte pour le PREMIER coin du rectangle');

        function showInfoBanner(text) {
            if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
            bannerEl = document.createElement('div');
            bannerEl.id = 'pwaDrawInfo';
            bannerEl.style.cssText =
                'position:fixed;top:110px;left:50%;transform:translateX(-50%);' +
                'z-index:100065;background:rgba(40,40,40,0.95);color:#fff;' +
                'padding:8px 16px;border-radius:18px;' +
                'font:600 12px Segoe UI,sans-serif;max-width:88vw;text-align:center;';
            bannerEl.textContent = text;
            (document.body || document.documentElement).appendChild(bannerEl);
        }

        function onClick(e) {
            if (!firstCorner) {
                // Premier clic
                firstCorner = e.latlng;
                firstMarker = L.circleMarker(e.latlng, {
                    radius: 8, color: '#8b4513', fillColor: '#f39c12',
                    weight: 3, fillOpacity: 1
                }).addTo(map);
                showInfoBanner('Tap 2 ailleurs sur la carte pour le COIN OPPOSE');
                showToast('Premier coin pose. Tape le coin oppose.', 3000);
            } else {
                // Deuxieme clic : valider
                var b = L.latLngBounds(firstCorner, e.latlng);
                var nePt = map.latLngToContainerPoint(b.getNorthEast());
                var swPt = map.latLngToContainerPoint(b.getSouthWest());
                var dx = Math.abs(nePt.x - swPt.x), dy = Math.abs(nePt.y - swPt.y);
                if (dx < 5 || dy < 5) {
                    // Rectangle minuscule : probable double-tap accidentel
                    showInfoBanner('Trop petit (' + dx + 'x' + dy + 'px). Tape plus loin.');
                    showToast('Rectangle trop petit, tape plus loin', 2500);
                    return;
                }
                // Tracer le rectangle final
                rectLayer = L.rectangle(b, {
                    color: '#8b4513', weight: 4, fillOpacity: 0.25, dashArray: '6,4'
                }).addTo(map);
                showToast('Rectangle OK (' + dx + 'x' + dy + 'px), ouverture du modal...', 1500);
                // Delai pour que l'utilisateur voie le rectangle avant le modal
                setTimeout(function() {
                    cleanup(true);
                    openPrecacheModal(b);
                }, 800);
            }
        }

        function onEsc(ev) {
            if (ev.key === 'Escape') {
                cleanup();
                openPrecacheModal();
            }
        }

        function cleanup(keepRect) {
            map.off('click', onClick);
            document.removeEventListener('keydown', onEsc);
            hideDrawCancelButton();
            if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
            if (firstMarker) { try { map.removeLayer(firstMarker); } catch(_e) {} }
            firstMarker = null;
            firstCorner = null;
            if (rectLayer && !keepRect) {
                try { map.removeLayer(rectLayer); } catch(_e) {}
                rectLayer = null;
            } else if (rectLayer && keepRect) {
                var lyr = rectLayer;
                setTimeout(function() { try { map.removeLayer(lyr); } catch(_e) {} }, 1200);
                rectLayer = null;
            }
        }

        map.on('click', onClick);
        document.addEventListener('keydown', onEsc);
    }

    // ===== Construction des URLs et envoi au SW =====
    function findLeafletMap() {
        for (var k in window) {
            try {
                if (window[k] && window[k]._container && window[k]._container.classList &&
                    window[k]._container.classList.contains('leaflet-container')) {
                    return window[k];
                }
            } catch(e) {}
        }
        return null;
    }

    function countActiveTileLayers(map) {
        var count = 0;
        map.eachLayer(function(l) {
            if (l instanceof L.TileLayer && l._url && l._url.indexOf('{z}') !== -1) count++;
        });
        return Math.max(count, 1);
    }

    function collectTileLayerUrls(map) {
        var urls = [];
        map.eachLayer(function(l) {
            if (l instanceof L.TileLayer && l._url && l._url.indexOf('{z}') !== -1) {
                urls.push(l._url);
            }
        });
        return urls;
    }

    // Liste TOUS les TileLayer disponibles via le LayerControl (actifs + inactifs).
    // Folium attache les couches inactives au layer control. On parcourt :
    // - map._layers (actifs)
    // - le LayerControl Leaflet (actifs + inactifs)
    // - aussi les layers refs dans les variables globales Folium (layer_xxx)
    function listAvailableLayers(map) {
        var out = [];
        var seen = new Set();
        function tryAdd(lyr, name, active) {
            if (!lyr || !lyr._url || lyr._url.indexOf('{z}') === -1) return;
            var id = L.stamp(lyr);
            if (seen.has(id)) {
                // Mettre a jour active si on l'avait classe inactif et qu'on le voit actif
                if (active) {
                    out.forEach(function(o) { if (o.id === id) o.active = true; });
                }
                return;
            }
            seen.add(id);
            out.push({
                id: id,
                name: name || layerDisplayName(lyr),
                url: lyr._url,
                active: !!active
            });
        }

        // 1. Tous les layers Leaflet actifs sur la map
        map.eachLayer(function(l) {
            if (l instanceof L.TileLayer) tryAdd(l, null, true);
        });

        // 2. LayerControl Leaflet : cherche les references aux layers (actifs + inactifs)
        // Folium genere une variable globale type `layer_control_xxx` qui contient
        // les overlays et basemaps via `.options` ou `._layers`.
        var controls = [];
        for (var k in window) {
            try {
                var ctl = window[k];
                if (!ctl || typeof ctl !== 'object') continue;
                // Pattern Folium : variable nommee 'layer_control_*'
                if (k.indexOf('layer_control') === 0 && ctl._layers) controls.push(ctl);
                // Sinon : detection generique par presence de _layers + addBaseLayer/addOverlay
                else if (ctl._layers && (typeof ctl.addBaseLayer === 'function' || typeof ctl.addOverlay === 'function')) controls.push(ctl);
            } catch(e) {}
        }
        controls.forEach(function(ctl) {
            try {
                var entries = ctl._layers;
                if (!entries) return;
                // Differents formats selon version Leaflet : array ou object
                var iter = Array.isArray(entries) ? entries : Object.keys(entries).map(function(k) { return entries[k]; });
                iter.forEach(function(e) {
                    if (!e || !e.layer) return;
                    if (!(e.layer instanceof L.TileLayer)) return;
                    var isActive = map.hasLayer(e.layer);
                    tryAdd(e.layer, e.name, isActive);
                });
            } catch(e) {}
        });

        // 3. Backup : parcourir aussi les variables globales `tile_layer_*` Folium
        for (var k2 in window) {
            try {
                var v = window[k2];
                if (v && v instanceof L.TileLayer && k2.indexOf('tile_layer') === 0) {
                    tryAdd(v, null, map.hasLayer(v));
                }
            } catch(e) {}
        }

        // 4. Fallback : calques Corse-specifiques connus. Permet de pre-cacher
        // MEME si le calque n'est pas (encore) dans la map (cas du MNT LiDAR HD
        // ajoute en differe via setTimeout). On ajoute juste l'URL connue, sans
        // nettoyer du LayerControl. La detection par URL evite les doublons.
        var FALLBACK_LAYERS = [
            {
                name: 'MNT LiDAR HD (ombrage)',
                url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
                key: 'lidar-hd-shadow'
            },
            {
                name: 'Plan IGN J+1',
                url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.MAPS.BDUNI.J1&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
                key: 'plan-ign-j1'
            },
            {
                name: 'Satellite IGN HD',
                url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',
                key: 'orthophotos-actuelles'
            },
            {
                name: 'Photo aerienne 1950-1965',
                url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS.1950-1965&STYLE=BDORTHOHISTORIQUE&TILEMATRIXSET=PM_0_18&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
                key: 'orthophotos-1950'
            },
            {
                name: 'Photo aerienne 1965-1980',
                url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS.1965-1980&STYLE=BDORTHOHISTORIQUE&TILEMATRIXSET=PM_3_18&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
                key: 'orthophotos-1965'
            },
            {
                name: 'Cadastre IGN (Parcellaire)',
                url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=CADASTRALPARCELS.PARCELLAIRE_EXPRESS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
                key: 'cadastre-ign'
            },
            {
                // Plan Terrier Corse XVIIIe (WMTS : STYLE=nolegend, TMS=PM_6_18,
                // zooms 6-18 uniquement). La carte l'affiche en WMS -> non
                // cacheable ; le proposer ici en XYZ permet de le pre-cacher.
                name: 'Plan Terrier (XVIIIe)',
                url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.TERRIER_V2&STYLE=nolegend&TILEMATRIXSET=PM_6_18&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
                key: 'terrier'
            },
            {
                name: 'OpenStreetMap',
                url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
                key: 'osm'
            }
        ];
        FALLBACK_LAYERS.forEach(function(fb) {
            // Ne pas ajouter si une URL identique existe deja (dedupe par contenu)
            var alreadyHas = out.some(function(o) {
                // Comparaison par segment unique de l'URL (identifie le layer)
                // MNT LiDAR + Plan Terrier : TOUJOURS proposes en entree nommee
                // (suppression dedup desactivee -> visibles meme si une variante
                //  WMS / chargee en differe / mal nommee existe deja).
                if (fb.key === 'lidar-hd-shadow') return false;
                if (fb.key === 'terrier') return false;
                if (fb.key === 'plan-ign-j1') return o.url.indexOf('BDUNI.J1') >= 0;
                if (fb.key === 'orthophotos-actuelles') return /ORTHOIMAGERY\.ORTHOPHOTOS&/i.test(o.url) || /ORTHOIMAGERY\.ORTHOPHOTOS$/i.test(o.url.split('&')[0]);
                if (fb.key === 'orthophotos-1950') return o.url.indexOf('1950-1965') >= 0;
                if (fb.key === 'orthophotos-1965') return o.url.indexOf('1965-1980') >= 0;
                if (fb.key === 'cadastre-ign') return o.url.indexOf('CADASTRALPARCELS') >= 0;
                if (fb.key === 'osm') return o.url.indexOf('openstreetmap.org') >= 0;
                return false;
            });
            if (!alreadyHas) {
                // Genere un id stable (negatif pour distinguer des stamp Leaflet)
                var fakeId = -1000 - out.length;
                out.push({
                    id: fakeId,
                    name: fb.name + ' (suggere)',
                    url: fb.url,
                    active: false  // Inactif par defaut, l'utilisateur coche pour inclure
                });
            }
        });

        return out;
    }

    function layerDisplayName(l) {
        var attr = l.options.attribution || '';
        // Tenter d'extraire un nom court depuis l'attribution ou l'URL
        if (/openstreetmap/i.test(attr)) return 'OpenStreetMap';
        if (/opentopomap/i.test(attr)) return 'OpenTopoMap';
        if (/esri/i.test(attr)) return 'Satellite Esri';
        if (/bd ortho/i.test(attr) || /ORTHOPHOTOS&/i.test(l._url)) return 'Satellite IGN HD';
        if (/PLANIGN/i.test(l._url)) return 'IGN Plan v2';
        if (/BDUNI\.J1/i.test(l._url)) return 'Plan IGN J+1';
        if (/1950-1965/i.test(l._url)) return 'Ortho 1950-1965';
        if (/1965-1980/i.test(l._url)) return 'Ortho 1965-1980';
        if (/raster-tiles-corse/i.test(l._url)) {
            var m = /raster-tiles-corse\/([^\/]+)/.exec(l._url);
            return m ? 'Raster : ' + m[1] : 'Raster Corse';
        }
        return l._url.split('/')[2] || 'Couche';
    }

    // Liste les projets disponibles depuis le scope global Folium-injecte.
    function listAvailableProjects() {
        var projets = (typeof window.PROJETS_DISPONIBLES !== 'undefined' && window.PROJETS_DISPONIBLES) || [];
        var currentId = typeof window.PROJET_ID !== 'undefined' ? window.PROJET_ID : null;
        return projets.map(function(p) {
            return {
                id: p.id,
                nom: p.nom || ('Projet ' + p.id),
                current: (p.id == currentId)
            };
        });
    }

    // Bounds approximatifs de la Corse (pour pre-cache automatique du contexte
    // dezoomé : tu peux toujours voir la Corse complete meme hors-ligne).
    var CORSE_BOUNDS = { south: 41.30, west: 8.50, north: 43.05, east: 9.65 };

    // Niveau de contexte Corse deja telecharge ('light' = 8-10, 'full' = 8-14).
    // Flag GLOBAL (pas par carte) : le cache tuiles est partage par tout le
    // domaine GitHub Pages, donc valable pour toutes les cartes.
    function _getCorseContextLevel() {
        try { return localStorage.getItem('pwaCorseContextLevel') || ''; }
        catch(_e) { return ''; }
    }
    function _setCorseContextLevel(level) {
        try {
            if (level) localStorage.setItem('pwaCorseContextLevel', level);
            else localStorage.removeItem('pwaCorseContextLevel');
        } catch(_e) {}
    }

    // ===== Anti-eviction : stockage persistant + verif quota =====
    // navigator.storage.persist() : si accorde, le navigateur n'evince PLUS
    // automatiquement (seul un vidage manuel supprime). Accorde sans prompt
    // pour une PWA installee sur Android Chrome.
    function _requestPersistentStorage(verbose) {
        if (!(navigator.storage && navigator.storage.persist)) {
            return Promise.resolve(false);
        }
        var persistedCheck = navigator.storage.persisted
            ? navigator.storage.persisted() : Promise.resolve(false);
        return persistedCheck.then(function(already) {
            if (already) {
                console.log('[PWA] Stockage deja persistant');
                return true;
            }
            return navigator.storage.persist().then(function(granted) {
                console.log('[PWA] Stockage persistant : ' + (granted ? 'ACCORDE' : 'refuse'));
                if (verbose) {
                    showToast(granted
                        ? 'Stockage persistant active : tes tuiles ne seront plus evincees automatiquement.'
                        : 'Stockage persistant refuse. Installe la carte sur l\'ecran d\'accueil pour l\'obtenir.', 6000);
                }
                return granted;
            }).catch(function() { return false; });
        }).catch(function() { return false; });
    }

    // {usage, quota, available} en octets, ou null si API indispo
    function _storageEstimate() {
        if (!(navigator.storage && navigator.storage.estimate)) {
            return Promise.resolve(null);
        }
        return navigator.storage.estimate().then(function(e) {
            var usage = e.usage || 0, quota = e.quota || 0;
            return { usage: usage, quota: quota, available: Math.max(0, quota - usage) };
        }).catch(function() { return null; });
    }

    // Verifie si estimatedBytes rentre dans l'espace dispo. Promise<bool> :
    // true = continuer (OK ou utilisateur confirme malgre l'avertissement).
    function _checkQuotaBeforeDownload(estimatedBytes) {
        return _storageEstimate().then(function(est) {
            if (!est || !est.quota) return true;  // API indispo : ne pas bloquer
            if (estimatedBytes > est.available * 0.9) {
                var needMo = Math.round(estimatedBytes / 1e6);
                var freeMo = Math.round(est.available / 1e6);
                return confirm(
                    'Espace de stockage potentiellement insuffisant.\n\n' +
                    'Telechargement estime : ~' + needMo + ' Mo\n' +
                    'Espace disponible : ~' + freeMo + ' Mo\n\n' +
                    'Le navigateur risque de refuser ou d\'evincer des tuiles en cours de route.\n' +
                    'Telecharger quand meme ?');
            }
            return true;
        });
    }

    // ===== Persistance + visualisation de la zone pre-cachee =====
    // On stocke les bounds + zoom range dans localStorage par carte.
    // L'utilisateur peut afficher cette zone sur la carte a tout moment via
    // le menu, et l'ajuster en redessinant.
    function _zoneKey() {
        var fn = (location.pathname.split('/').pop()) || 'carte.html';
        return 'pwaPrecachedZone_' + fn;
    }
    function getStoredZone() {
        try { return JSON.parse(localStorage.getItem(_zoneKey()) || 'null'); }
        catch(_e) { return null; }
    }
    function setStoredZone(zone) {
        try { localStorage.setItem(_zoneKey(), JSON.stringify(zone)); } catch(_e) {}
    }
    function clearStoredZone() {
        try { localStorage.removeItem(_zoneKey()); } catch(_e) {}
    }
    // Flag : l'utilisateur a-t-il explicitement masque la zone ?
    // Par defaut la zone est AFFICHEE (en ligne comme hors-ligne). Si l'utilisateur
    // clique "Masquer", on memorise pour ne plus l'afficher au prochain chargement.
    function _zoneHiddenKey() {
        var fn = (location.pathname.split('/').pop()) || 'carte.html';
        return 'pwaZoneHidden_' + fn;
    }
    function _zoneHiddenByUser() {
        try { return localStorage.getItem(_zoneHiddenKey()) === '1'; }
        catch(_e) { return false; }
    }
    function _setZoneHidden(hidden) {
        try {
            if (hidden) localStorage.setItem(_zoneHiddenKey(), '1');
            else localStorage.removeItem(_zoneHiddenKey());
        } catch(_e) {}
    }

    // Layer Leaflet pour afficher la zone precachee (rectangle OU polygones communes).
    // `_zoneLayer` peut etre un seul layer ou un FeatureGroup si plusieurs polygones.
    var _zoneLayer = null;
    function showPrecachedZoneOnMap(persistent) {
        var map = findLeafletMap();
        if (!map) return false;
        var zone = getStoredZone();
        if (!zone || !zone.bounds) {
            showToast('Aucune zone pre-cachee enregistree pour cette carte.', 4000);
            return false;
        }
        if (_zoneLayer) try { map.removeLayer(_zoneLayer); } catch(_e) {}
        var bb = L.latLngBounds(zone.bounds[0], zone.bounds[1]);
        var hasCommunes = zone.communes && zone.communes.length > 0;
        // Contour purement visuel : PAS de popup (inutile au clic) et
        // interactive:false -> les clics passent a travers vers la carte.
        if (hasCommunes) {
            var group = L.featureGroup();
            zone.communes.forEach(function(c) {
                (c.polygons || []).forEach(function(poly) {
                    L.polygon(poly, {
                        color: '#8b4513', weight: 2, fillOpacity: 0.10,
                        dashArray: '6,4', interactive: false
                    }).addTo(group);
                });
            });
            _zoneLayer = group.addTo(map);
        } else {
            _zoneLayer = L.rectangle(bb, {
                color: '#8b4513', weight: 3, fillOpacity: 0.10,
                dashArray: '8,4', interactive: false
            }).addTo(map);
        }
        // Fit sur la zone si demande
        if (!persistent) map.fitBounds(bb, { padding: [40, 40] });
        return true;
    }
    function hidePrecachedZoneOnMap() {
        var map = findLeafletMap();
        if (_zoneLayer && map) try { map.removeLayer(_zoneLayer); } catch(_e) {}
        _zoneLayer = null;
    }
    function isPrecachedZoneVisible() {
        return _zoneLayer !== null;
    }

    // deepLayerSpec : { url, zmax } -> une couche precise (ex: Plan IGN J+1,
    // tuiles legeres) cachee plus profond que les autres sur la meme emprise.
    async function startPrecache(map, bounds, zmin, zmax, includeCorse, customLayerUrls, projectIds, precacheTag, precacheLabel, deepLayerSpec) {
        if (!navigator.serviceWorker.controller) {
            alert('Service Worker non actif (la page doit etre en HTTPS et rechargee).');
            return;
        }
        var layerUrls = customLayerUrls || collectTileLayerUrls(map);
        if (layerUrls.length === 0) {
            alert('Aucune couche de tuiles selectionnee.');
            return;
        }
        var tileUrls = [];

        function addTilesForBounds(z, nb, sb, wb, eb, templates) {
            var tpls = templates || layerUrls;
            var n = Math.pow(2, z);
            var xmin = Math.floor((wb + 180) / 360 * n);
            var xmax = Math.floor((eb + 180) / 360 * n);
            var ymin = Math.floor((1 - Math.log(Math.tan(nb * Math.PI / 180) + 1 / Math.cos(nb * Math.PI / 180)) / Math.PI) / 2 * n);
            var ymax = Math.floor((1 - Math.log(Math.tan(sb * Math.PI / 180) + 1 / Math.cos(sb * Math.PI / 180)) / Math.PI) / 2 * n);
            for (var x = Math.min(xmin, xmax); x <= Math.max(xmin, xmax); x++) {
                for (var y = Math.min(ymin, ymax); y <= Math.max(ymin, ymax); y++) {
                    tpls.forEach(function(tpl) {
                        if (tpl.indexOf('{s}') !== -1) {
                            ['a','b','c'].forEach(function(sub) {
                                tileUrls.push(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', sub));
                            });
                        } else {
                            tileUrls.push(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
                        }
                    });
                }
            }
        }

        // 1. Zone selectionnee aux zooms demandes
        var nb = bounds.getNorth(), sb = bounds.getSouth();
        var wb = bounds.getWest(), eb = bounds.getEast();
        for (var z = zmin; z <= zmax; z++) {
            addTilesForBounds(z, nb, sb, wb, eb);
        }

        // 1bis. Couche dediee (ex: Plan IGN J+1, tuiles legeres) poussee plus
        // profond sur la meme emprise -> rendu net a zoom eleve sans gonfler
        // le stockage des couches lourdes.
        var _effZmax = zmax;
        if (deepLayerSpec && deepLayerSpec.url && deepLayerSpec.zmax > zmax) {
            for (var dz = zmax + 1; dz <= deepLayerSpec.zmax; dz++) {
                addTilesForBounds(dz, nb, sb, wb, eb, [deepLayerSpec.url]);
            }
            _effZmax = deepLayerSpec.zmax;
        }

        // 2. Contexte Corse optionnel. includeCorse = zmax du contexte
        //    (nombre) ; true historique => 10. Zooms 8..ctxZmax sur la Corse.
        if (includeCorse) {
            var ctxZmax = (typeof includeCorse === 'number' && includeCorse >= 8)
                ? includeCorse : 10;
            for (var cz = 8; cz <= ctxZmax; cz++) {
                if (cz >= zmin && cz <= zmax) continue;
                addTilesForBounds(cz, CORSE_BOUNDS.north, CORSE_BOUNDS.south, CORSE_BOUNDS.west, CORSE_BOUNDS.east);
            }
            // Contexte detaille (ctxZmax >= 14) : pousser le Plan IGN J+1
            // (couche legere) jusqu'a z15 sur toute la Corse, comme l'install
            // complet. Les couches lourdes restent a ctxZmax.
            if (ctxZmax >= 14) {
                var _planUrl = null;
                for (var _pi = 0; _pi < layerUrls.length; _pi++) {
                    if (/GEOGRAPHICALGRIDSYSTEMS\.PLANIGNV2|GEOGRAPHICALGRIDSYSTEMS\.MAPS\.BDUNI\.J1/i.test(layerUrls[_pi])) {
                        _planUrl = layerUrls[_pi]; break;
                    }
                }
                if (_planUrl) {
                    for (var pz = ctxZmax + 1; pz <= 15; pz++) {
                        addTilesForBounds(pz, CORSE_BOUNDS.north, CORSE_BOUNDS.south,
                            CORSE_BOUNDS.west, CORSE_BOUNDS.east, [_planUrl]);
                    }
                }
            }
        }

        // 3. Pre-cache des projets : on doit fetch EXACTEMENT les memes URLs
        // que l'app a l'execution (loadCustomFeatures / loadModifications),
        // sinon la cle de cache du SW ne matche pas -> rien hors-ligne.
        //   loadCustomFeatures : /custom_features?select=*&order=created_at.desc
        //                        [&projet_id=eq.<pid>]&limit=1000&offset=<n>
        //   loadModifications  : /corrections?select=*&projet_id=eq.<pid>
        var projectPhotoUrls = [];
        if (projectIds && projectIds.length > 0) {
            showToast('Telechargement data des projets...', 3000);
            var supaBase = (typeof window.SUPABASE_URL !== 'undefined' && window.SUPABASE_URL) || '';
            var supaKey = (typeof window.SUPABASE_KEY !== 'undefined' && window.SUPABASE_KEY) || '';
            var supaHdr = { apikey: supaKey, Authorization: 'Bearer ' + supaKey };
            for (var pi = 0; pi < projectIds.length && supaBase && supaKey; pi++) {
                var pid = projectIds[pi];
                try {
                    // 3a. custom_features (pagine par 1000, URL byte-exacte)
                    var cfBase = supaBase + '/rest/v1/custom_features?select=*&order=created_at.desc'
                        + '&projet_id=eq.' + encodeURIComponent(pid);
                    var offset = 0, pageSize = 1000, total = 0;
                    while (true) {
                        var cfUrl = cfBase + '&limit=' + pageSize + '&offset=' + offset;
                        var cfResp = await fetch(cfUrl, { headers: supaHdr });
                        if (!cfResp.ok) break;
                        var page = await cfResp.json();
                        if (!Array.isArray(page)) break;
                        page.forEach(function(f) {
                            if (f.photo_url) projectPhotoUrls.push(f.photo_url);
                            if (f.photo_url2) projectPhotoUrls.push(f.photo_url2);
                        });
                        total += page.length;
                        if (page.length < pageSize) break;
                        offset += pageSize;
                        if (offset > 50000) break;  // garde-fou
                    }
                    // 3b. corrections (loadModifications, vue projet)
                    var corrUrl = supaBase + '/rest/v1/corrections?select=*&projet_id=eq.' + pid;
                    try { await fetch(corrUrl, { headers: supaHdr }); } catch (e2) {}
                    console.log('[Pre-cache] Projet ' + pid + ' : ' + total + ' features + corrections');
                } catch (e) {
                    console.warn('[Pre-cache] Echec projet ' + pid + ' :', e);
                }
            }
        }

        // 4. Concatener tuiles + photos pour un seul send au SW
        var allUrls = tileUrls.concat(projectPhotoUrls);

        var modal = document.getElementById('pwaPrecacheModal');
        if (modal) {
            modal.querySelector('#pwaPProgress').style.display = 'block';
            modal.querySelector('#pwaPStart').disabled = true;
        }

        var ch = new MessageChannel();
        ch.port1.onmessage = function(ev) {
            var d = ev.data;
            if (d.progress === undefined) return;
            var pct = d.total ? Math.round((d.progress / d.total) * 100) : 0;
            // Progression : barre dans la modale si ouverte, sinon bandeau leger
            // (cas du pre-cache declenche a l'installation, sans modale).
            if (modal) {
                modal.querySelector('#pwaPBar').style.width = pct + '%';
                modal.querySelector('#pwaPLabel').textContent = d.progress + ' / ' + d.total + ' (' + pct + '%)' + (d.errors ? ' — ' + d.errors + ' erreurs' : '');
            } else {
                _updatePrecacheBanner(d.progress, d.total, pct, d.errors, d.done);
            }
            // Completion : TOUJOURS executee (independante de la modale) sinon
            // la zone n'est jamais sauvegardee quand on pre-cache depuis l'install.
            if (d.done) {
                var zone = {
                    bounds: [
                        [bounds.getSouth(), bounds.getWest()],
                        [bounds.getNorth(), bounds.getEast()]
                    ],
                    zmin: zmin, zmax: _effZmax,
                    includeCorse: !!includeCorse,
                    nLayers: layerUrls.length,
                    timestamp: Date.now()
                };
                if (_pendingCommunePolys) {
                    zone.communes = _pendingCommunePolys.map(function(p) {
                        return { code: p.code, nom: p.nom, polygons: p.polygons };
                    });
                    _pendingCommunePolys = null;
                }
                setStoredZone(zone);
                _setZoneHidden(false);  // nouvelle zone : afficher par defaut
                // Memoriser le niveau de contexte Corse pour ne plus le reproposer
                if (precacheTag === 'corse-full') _setCorseContextLevel('full');
                else if (precacheTag === 'corse-light') _setCorseContextLevel('light');
                // Enregistrer ce batch pour suppression selective ulterieure
                try {
                    var _isCtxB = (precacheTag === 'corse-light' || precacheTag === 'corse-full');
                    var _lbl = precacheLabel;
                    if (!_lbl) {
                        if (_isCtxB) {
                            _lbl = precacheTag === 'corse-full'
                                ? 'Contexte Corse complet (8-14)'
                                : 'Contexte Corse leger (8-10)';
                        } else if (zone.communes && zone.communes.length) {
                            _lbl = 'Communes : ' + zone.communes.map(function(c){return c.nom;})
                                .slice(0, 3).join(', ') +
                                (zone.communes.length > 3 ? ' +' + (zone.communes.length - 3) : '');
                        } else {
                            _lbl = 'Zone (zoom ' + zmin + '-' + zmax + ')';
                        }
                    }
                    dbBatchPut({
                        id: 'pcb-' + Date.now(),
                        label: _lbl,
                        kind: _isCtxB ? 'context' : 'tiles',
                        contextCache: _isCtxB,
                        date: Date.now(),
                        zmin: zmin, zmax: _effZmax,
                        count: allUrls.length,
                        urls: _isCtxB ? [] : allUrls  // context = cache dedie, pas besoin des urls
                    });
                } catch(_e) { console.warn('[PWA] Enregistrement batch echoue :', _e); }
                try { showPrecachedZoneOnMap(true); } catch(_e) {}
                // Nouveau zoom max cache -> re-caler le maxNativeZoom adaptatif
                setTimeout(function() {
                    try { _applyAdaptiveNativeZoom(); } catch(_e) {}
                }, 800);
                setTimeout(function() {
                    if (modal && modal.parentNode) modal.remove();
                    showToast('Pre-cache termine : ' + d.progress + ' elements' + (d.errors ? ' (' + d.errors + ' erreurs)' : ''));
                }, 500);
            }
        };
        // context=true -> le SW range ces tuiles dans CTX_CACHE (preserve au
        // vidage de cache sauf choix explicite de l'utilisateur).
        var _isCtx = (precacheTag === 'corse-light' || precacheTag === 'corse-full');
        navigator.serviceWorker.controller.postMessage(
            { type: 'PRECACHE_URLS', urls: allUrls, context: _isCtx }, [ch.port2]);
    }

    // ===== Bandeau de progression leger (pre-cache sans modale) =====
    // Utilise quand le pre-cache est declenche depuis le flux d'installation
    // (pas de modale pwaPrecacheModal ouverte). Petit bandeau en haut, discret.
    function _updatePrecacheBanner(progress, total, pct, errors, done) {
        var b = document.getElementById('pwaPrecacheBanner');
        if (!b) {
            b = document.createElement('div');
            b.id = 'pwaPrecacheBanner';
            b.style.cssText =
                'position:fixed !important;top:14px !important;left:50% !important;' +
                'transform:translateX(-50%);z-index:100045 !important;' +
                'display:flex;align-items:center;gap:10px;padding:8px 16px;' +
                'background:rgba(40,40,40,0.95);color:#fff;border-radius:20px;' +
                'box-shadow:0 4px 14px rgba(0,0,0,0.25);font:600 12px Segoe UI,sans-serif;' +
                'max-width:90vw;';
            (document.body || document.documentElement).appendChild(b);
        }
        if (done) {
            b.innerHTML = 'Fonds Corse hors-ligne pret (' + progress + ' tuiles' +
                (errors ? ', ' + errors + ' erreurs' : '') + ')';
            setTimeout(function() { if (b.parentNode) b.parentNode.removeChild(b); }, 5000);
            return;
        }
        b.innerHTML =
            '<span style="display:inline-block;width:60px;height:6px;background:rgba(255,255,255,0.25);border-radius:3px;overflow:hidden;">' +
            '<span style="display:block;height:100%;width:' + pct + '%;background:#27ae60;transition:width .3s;"></span></span>' +
            '<span>Telechargement fonds Corse ' + pct + '% (' + progress + '/' + total + ')</span>';
    }

    // ===== Pre-cache Corse complete (declenche a l'installation) =====
    // kind = 'light'  -> zooms 8-10  (~quelques Mo, reperage ile entiere)
    // kind = 'full'   -> zooms 8-14  (~350 Mo, routes/chemins partout)
    // Attend que le SW soit actif + la carte prete (retries), puis lance
    // startPrecache sur la bbox Corse avec les couches actives.
    function _startCorsePrecache(kind, _attempt) {
        if (kind !== 'light' && kind !== 'full') return;
        _attempt = _attempt || 0;
        var map = findLeafletMap();
        var swReady = navigator.serviceWorker && navigator.serviceWorker.controller;
        if ((!map || !swReady) && _attempt < 20) {
            setTimeout(function() { _startCorsePrecache(kind, _attempt + 1); }, 700);
            return;
        }
        if (!map || !swReady) {
            showToast('Pre-cache Corse impossible (carte ou Service Worker non pret). Reessaie via "Pre-charger une zone".', 7000);
            return;
        }
        // Jeu de couches DETERMINISTE (independant des calques affiches) :
        // Satellite HD IGN + Plan IGN J+1. On reutilise en priorite l'URL
        // reelle de la couche sur la carte (pour que l'affichage hors-ligne
        // corresponde), sinon l'URL canonique connue.
        var _avail = (typeof listAvailableLayers === 'function')
            ? listAvailableLayers(map) : [];
        function _findUrl(re) {
            for (var i = 0; i < _avail.length; i++) {
                if (_avail[i].url && re.test(_avail[i].url)) return _avail[i].url;
            }
            return null;
        }
        var SAT_FALLBACK = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg';
        var PLAN_FALLBACK = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png';
        var satUrl = _findUrl(/ORTHOIMAGERY\.ORTHOPHOTOS(?!\.\d)/i) || SAT_FALLBACK;
        var planUrl = _findUrl(/GEOGRAPHICALGRIDSYSTEMS\.PLANIGNV2/i)
            || _findUrl(/GEOGRAPHICALGRIDSYSTEMS\.MAPS\.BDUNI\.J1/i) || PLAN_FALLBACK;
        // Light ET full conservent les 2 couches (satellite + Plan IGN J+1).
        var layerUrls = [satUrl, planUrl];
        var bounds = L.latLngBounds(
            [CORSE_BOUNDS.south, CORSE_BOUNDS.west],
            [CORSE_BOUNDS.north, CORSE_BOUNDS.east]
        );
        var zmax = (kind === 'full') ? 14 : 10;
        // Plan IGN J+1 reste a z14 comme le satellite (pas de z15 : trop lourd).
        var _deepSpec = null;
        // Estimation : light (sat+plan 8-10) ~10 Mo ; full (sat+plan 8-14) ~280 Mo.
        var _estBytes = (kind === 'full' ? 280 : 10) * 1e6;
        _checkQuotaBeforeDownload(_estBytes).then(function(okq) {
            if (!okq) { showToast('Telechargement annule (espace insuffisant).', 5000); return; }
            _requestPersistentStorage(false);
            showToast(kind === 'full'
                ? ('Telechargement du fond Corse complet'
                   + (_deepSpec ? ' + Plan IGN detaille (z15)' : '')
                   + '. Garder l\'app ouverte...')
                : 'Telechargement du contexte Corse (leger)...', 6000);
            startPrecache(map, bounds, 8, zmax, false, layerUrls, [],
                'corse-' + kind, null, _deepSpec);
        });
    }

    // ===== Personnalisation nom du raccourci PWA =====
    // Le nom du raccourci vient du manifest (genere dynamiquement au chargement
    // depuis localStorage 'pwaCustomName_<fichier>'). Pour personnaliser, on
    // ouvre une modal qui prend une saisie utilisateur, on sauvegarde et on
    // recharge la page (le manifest est figé au load).

    function getCurrentCustomName() {
        var fn = (location.pathname.split('/').pop()) || 'carte.html';
        var key = 'pwaCustomName_' + fn;
        try { return { key: key, name: localStorage.getItem(key) || '' }; }
        catch(_e) { return { key: key, name: '' }; }
    }

    // Applique le nom personnalise du raccourci AUX 3 CANAUX, depuis pwa-ui.js
    // (donc valable pour TOUTES les cartes, meme anciennes non regenerees) :
    //  - manifest.name/short_name (Chrome WebAPK) : on remplace le <link manifest>
    //  - document.title (fallback raccourci Chrome + onglet)
    //  - <meta apple-mobile-web-app-title> (iOS Safari ignore le manifest)
    // Doit s'executer TOT (avant que l'utilisateur declenche l'install) : OK
    // car pwa-ui.js est en defer -> s'execute apres le parse du <head>.
    function _applyCustomShortcutName() {
        var fn = (location.pathname.split('/').pop()) || 'carte.html';
        var customName = '';
        try { customName = (localStorage.getItem('pwaCustomName_' + fn) || '').trim(); }
        catch(_e) {}
        if (!customName) return;  // pas de nom perso : ne rien forcer
        try { document.title = customName; } catch(_e) {}
        try {
            var am = document.getElementById('pwaAppleTitle')
                || document.querySelector('meta[name="apple-mobile-web-app-title"]');
            if (!am) {
                am = document.createElement('meta');
                am.setAttribute('name', 'apple-mobile-web-app-title');
                document.head.appendChild(am);
            }
            am.setAttribute('content', customName.slice(0, 30));
        } catch(_e) {}
        try {
            // Remplacer le manifest (genere par le script inline avec l'ancien nom)
            var manifest = {
                name: customName.slice(0, 60),
                short_name: customName.length > 12 ? customName.slice(0, 12) : customName,
                description: 'Carte des toponymes cadastraux corses',
                start_url: fn,
                scope: './',
                display: 'standalone',
                orientation: 'any',
                background_color: '#18191a',
                theme_color: '#8b4513',
                lang: 'fr',
                icons: [
                    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
                    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
                    { src: 'icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' }
                ]
            };
            var blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
            var url = URL.createObjectURL(blob);
            // Retirer les anciens <link rel="manifest">
            document.querySelectorAll('link[rel="manifest"]').forEach(function(l) {
                try { l.parentNode.removeChild(l); } catch(_e) {}
            });
            var link = document.createElement('link');
            link.rel = 'manifest';
            link.href = url;
            document.head.appendChild(link);
            console.log('[PWA] Nom raccourci applique via pwa-ui.js : ' + customName);
        } catch(_e) {
            console.warn('[PWA] _applyCustomShortcutName echoue :', _e);
        }
    }
    // Execution immediate (pas dans un listener load) pour devancer l'install.
    _applyCustomShortcutName();

    function openRenameShortcutModal(onSave) {
        var existing = document.getElementById('pwaRenameModal');
        if (existing) { existing.remove(); return; }
        var cur = getCurrentCustomName();
        var defaultName = cur.name || (document.title || '').trim().replace(/^(Folium\s+Map|carte_polygones_[\w-]+)\s*[-_]?\s*/i, '');

        var m = document.createElement('div');
        m.id = 'pwaRenameModal';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10500;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);
        m.innerHTML =
            '<div style="background:#fff;border-radius:10px;max-width:460px;width:100%;padding:20px 24px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
            '<h2 style="margin:0;font-size:17px;color:#5a3a1a;">Nom du raccourci</h2>' +
            '<button id="pwaRClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:#8b7355;">&times;</button>' +
            '</div>' +
            '<p style="margin:0 0 14px;font-size:12px;color:#666;line-height:1.5;">Nom du raccourci sur l\'ecran d\'accueil (max 12 caracteres).</p>' +
            '<input type="text" id="pwaRInput" maxlength="60" value="' + escapeHtml(defaultName) + '" placeholder="Nom du raccourci" style="width:100%;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:14px;margin-bottom:6px;">' +
            '<div id="pwaRPreview" style="font-size:11px;color:#888;margin-bottom:14px;"></div>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
            '<button id="pwaRReset" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Defaut</button>' +
            '<button id="pwaRCancel" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Annuler</button>' +
            '<button id="pwaRSave" style="background:#8b4513;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Sauvegarder</button>' +
            '</div>' +
            '</div>';
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(m);
            L.DomEvent.disableScrollPropagation(m);
        }
        var input = document.getElementById('pwaRInput');
        var preview = document.getElementById('pwaRPreview');
        function updatePreview() {
            var v = (input.value || '').trim();
            var sn = v.length > 12 ? v.slice(0, 12) : v;
            preview.innerHTML = 'Apparaitra sur l\'ecran d\'accueil : <strong>' + escapeHtml(sn || '(vide)') + '</strong>' +
                (v.length > 12 ? ' <span style="color:#c0392b;">(tronque de "' + escapeHtml(v) + '")</span>' : '');
        }
        input.addEventListener('input', updatePreview);
        setTimeout(function() { input.focus(); input.select(); }, 50);
        updatePreview();

        document.getElementById('pwaRClose').onclick = function() { m.remove(); };
        document.getElementById('pwaRCancel').onclick = function() { m.remove(); };
        m.onclick = function(e) { if (e.target === m) m.remove(); };

        document.getElementById('pwaRReset').onclick = function() {
            try { localStorage.removeItem(cur.key); } catch(_e) {}
            showToast('Nom par defaut restaure. Recharge pour appliquer.');
            m.remove();
            if (onSave) onSave(null);
        };
        document.getElementById('pwaRSave').onclick = function() {
            var v = (input.value || '').trim();
            if (!v) { alert('Saisis un nom non vide.'); return; }
            try { localStorage.setItem(cur.key, v); } catch(_e) { alert('Echec sauvegarde locale.'); return; }
            m.remove();
            // Appliquer tout de suite (manifest + title + meta iOS) sans reload
            try { _applyCustomShortcutName(); } catch(_e) {}
            if (onSave) onSave(v);
            else {
                showToast('Nom enregistre et applique. (Si la carte est deja installee, desinstalle/reinstalle pour renommer l\'icone.)', 6000);
            }
        };
    }

    // ===== Intercepteur d'installation (Chrome/Edge/Samsung) =====
    // Capture beforeinstallprompt et affiche un bandeau d'install permanent
    // tant que l'app n'est pas installee. Sur iOS Safari (pas de prompt
    // natif), affiche des instructions manuelles.
    var _deferredInstallPrompt = null;

    function isPwaInstalled() {
        try {
            if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
            if (window.matchMedia && window.matchMedia('(display-mode: minimal-ui)').matches) return true;
            if (window.navigator && window.navigator.standalone === true) return true;  // iOS Safari
        } catch(_e) {}
        return false;
    }

    function isIosSafari() {
        var ua = navigator.userAgent || '';
        return /iPad|iPhone|iPod/.test(ua) && !window.MSStream && /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua);
    }

    function ensureInstallBanner() {
        // Pas de bandeau si deja installe
        if (isPwaInstalled()) {
            var existing = document.getElementById('pwaInstallBanner');
            if (existing) existing.remove();
            return;
        }
        // Pas de bandeau si l'utilisateur l'a explicitement masque pour cette session
        try { if (sessionStorage.getItem('pwaInstallDismissed') === '1') return; } catch(_e) {}
        if (document.getElementById('pwaInstallBanner')) return;

        var b = document.createElement('div');
        b.id = 'pwaInstallBanner';
        b.style.cssText =
            'position:fixed !important;top:14px !important;left:50% !important;' +
            'transform:translateX(-50%);z-index:100040 !important;' +
            'display:flex;align-items:center;gap:8px;padding:8px 14px;' +
            'background:rgba(40,40,40,0.95);color:#fff;border-radius:24px;' +
            'box-shadow:0 4px 14px rgba(0,0,0,0.25);font:600 12px Segoe UI,sans-serif;' +
            'cursor:pointer;max-width:90vw;';
        b.innerHTML =
            '<span>Installer cette carte sur l\'ecran d\'accueil</span>' +
            '<button id="pwaInstallBtnGo" style="background:#27ae60;color:#fff;border:none;padding:5px 12px;border-radius:14px;font:600 11px Segoe UI,sans-serif;cursor:pointer;">Installer</button>' +
            '<button id="pwaInstallBtnClose" title="Masquer jusqu\'au prochain rechargement" style="background:none;color:#bbb;border:none;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;">&times;</button>';
        (document.body || document.documentElement).appendChild(b);
        document.getElementById('pwaInstallBtnGo').onclick = function(e) {
            e.stopPropagation();
            b.remove();
            openInstallFlow();
        };
        document.getElementById('pwaInstallBtnClose').onclick = function(e) {
            e.stopPropagation();
            try { sessionStorage.setItem('pwaInstallDismissed', '1'); } catch(_e) {}
            b.remove();
        };
    }

    window.addEventListener('beforeinstallprompt', function(e) {
        e.preventDefault();
        _deferredInstallPrompt = e;
        console.log('[PWA] App installable (beforeinstallprompt capture)');
        ensureInstallBanner();
    });

    // Detecter la fin d'install + masquer le bandeau
    window.addEventListener('appinstalled', function() {
        console.log('[PWA] App installee');
        var b = document.getElementById('pwaInstallBanner');
        if (b) b.remove();
        showToast('Carte installee sur l\'ecran d\'accueil');
    });

    // Au load : afficher le bandeau si applicable (iOS Safari OU prompt deja capture)
    window.addEventListener('load', function() {
        setTimeout(function() {
            if (isPwaInstalled()) return;
            // Sur iOS Safari, pas de beforeinstallprompt mais on peut quand meme
            // proposer le banner avec instructions manuelles.
            if (isIosSafari() || _deferredInstallPrompt) {
                ensureInstallBanner();
            }
        }, 2500);
    });

    function openInstallFlow() {
        // Si deja installee, pas la peine de tout faire
        if (isPwaInstalled()) {
            showToast('App deja installee sur l\'ecran d\'accueil. Pour renommer, desinstalle d\'abord.', 6000);
            return;
        }
        openRenameShortcutModal(function(newName) {
            // Apres le choix du nom : proposer de pre-charger les fonds Corse.
            openInstallTilesModal(function(tileChoice) {
                _proceedInstall(newName, tileChoice);
            });
        });
    }

    // Modale : proposer le telechargement des fonds de carte Corse a l'install.
    // 3 choix : leger (8-10, ~qq Mo) / complet (8-14, ~350 Mo) / plus tard.
    function openInstallTilesModal(onChoice) {
        var existing = document.getElementById('pwaInstallTilesModal');
        if (existing) existing.remove();
        var map = findLeafletMap();
        // Jeu deterministe : Satellite HD + Plan IGN J+1 (independant des
        // calques affiches). Estimations Corse entiere fixes.
        var lightMo = 10;   // sat + plan, 8-10
        var fullMo = 280;   // sat + plan, 8-14

        var m = document.createElement('div');
        m.id = 'pwaInstallTilesModal';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100060;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);
        m.innerHTML =
            '<div style="background:#fff;border-radius:12px;max-width:460px;width:100%;padding:20px 24px;">' +
            '<h2 style="margin:0 0 6px;font-size:17px;color:#5a3a1a;">Fonds de carte hors-ligne</h2>' +
            '<p style="margin:0 0 16px;font-size:12px;color:#666;line-height:1.5;">' +
            'Fonds de la Corse pour l\'usage hors-ligne. Une zone precise reste pre-cachable plus tard.</p>' +
            '<button id="pwaTilesLight" style="display:block;width:100%;text-align:left;background:#f0ebe3;color:#5a3a1a;border:1px solid #d8cdb8;padding:11px 14px;border-radius:8px;cursor:pointer;font:600 13px Segoe UI,sans-serif;margin-bottom:8px;">' +
            'Leger — Satellite + Plan IGN <span style="color:#8b7355;">(zooms 8-10, ~' + lightMo + ' Mo)</span><br>' +
            '<span style="font-weight:400;font-size:11px;color:#888;">Vue ile entiere + grands axes. Rapide.</span></button>' +
            '<button id="pwaTilesFull" style="display:block;width:100%;text-align:left;background:#8b4513;color:#fff;border:none;padding:11px 14px;border-radius:8px;cursor:pointer;font:600 13px Segoe UI,sans-serif;margin-bottom:8px;">' +
            'Complet — Satellite + Plan IGN J+1 <span style="opacity:.85;">(zooms 8-14, ~' + fullMo + ' Mo)</span><br>' +
            '<span style="font-weight:400;font-size:11px;opacity:.85;">Se reperer routes/chemins partout. ~10-15 min en 4G.</span></button>' +
            '<button id="pwaTilesNone" style="display:block;width:100%;text-align:left;background:#fff;color:#8b7355;border:1px solid #e0d8c8;padding:10px 14px;border-radius:8px;cursor:pointer;font:600 12px Segoe UI,sans-serif;">' +
            'Plus tard — installer sans telecharger</button>' +
            '</div>';
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(m);
            L.DomEvent.disableScrollPropagation(m);
        }
        function pick(choice) { m.remove(); onChoice(choice); }
        document.getElementById('pwaTilesLight').onclick = function() { pick('light'); };
        document.getElementById('pwaTilesFull').onclick = function() { pick('full'); };
        document.getElementById('pwaTilesNone').onclick = function() { pick('none'); };
        m.onclick = function(e) { if (e.target === m) pick('none'); };
    }

    // Procede a l'installation + lance le pre-cache Corse selon le choix.
    // Si le nom a change -> reload (manifest regenere) puis precache APRES reload
    // (sinon le reload tuerait le telechargement). Sinon install + precache direct.
    function _proceedInstall(newName, tileChoice) {
        // Demander le stockage persistant des l'install (PWA installee =
        // accorde sans prompt) pour proteger les fonds telecharges.
        _requestPersistentStorage(true);
        if (newName) {
            var cur = getCurrentCustomName();
            if (cur.name !== newName) {
                showToast('Rechargement pour appliquer le nom...');
                setTimeout(function() {
                    sessionStorage.setItem('pwaInstallAfterReload', '1');
                    if (tileChoice === 'light' || tileChoice === 'full') {
                        try { sessionStorage.setItem('pwaPrecacheChoice', tileChoice); } catch(_e) {}
                    }
                    location.reload();
                }, 600);
                return;
            }
        }
        // Pas de reload : install direct puis pre-cache Corse en parallele
        triggerInstall();
        if (tileChoice === 'light' || tileChoice === 'full') {
            setTimeout(function() { _startCorsePrecache(tileChoice); }, 1200);
        }
    }

    function triggerInstall() {
        if (_deferredInstallPrompt) {
            _deferredInstallPrompt.prompt();
            _deferredInstallPrompt.userChoice.then(function(choice) {
                console.log('[PWA] Install choice :', choice.outcome);
                if (choice.outcome === 'accepted') {
                    showToast('Raccourci installe');
                } else {
                    showToast('Installation annulee. Tu peux reessayer plus tard.');
                    // Le prompt natif est consomme une fois ; on le re-capturera
                    // si le browser redeclenche beforeinstallprompt
                }
                _deferredInstallPrompt = null;
            });
        } else if (isIosSafari()) {
            // Afficher modal d'instructions iOS
            showIosInstallModal();
        } else {
            showToast('Utilise le menu navigateur (3 points) : "Ajouter a l\'ecran d\'accueil"', 7000);
        }
    }

    function showIosInstallModal() {
        var m = document.createElement('div');
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:100060;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
        (document.body || document.documentElement).appendChild(m);
        m.innerHTML =
            '<div style="background:#fff;border-radius:12px;max-width:380px;width:100%;padding:20px 24px;">' +
            '<h2 style="margin:0 0 10px;font-size:16px;color:#5a3a1a;">Installer sur iPhone / iPad</h2>' +
            '<ol style="margin:0 0 14px;padding-left:22px;font-size:13px;line-height:1.7;color:#333;">' +
            '<li>Tape le bouton <strong>Partager</strong> en bas de Safari (carre avec fleche vers le haut)</li>' +
            '<li>Fais defiler et choisis <strong>Sur l\'ecran d\'accueil</strong></li>' +
            '<li>Confirme avec <strong>Ajouter</strong> en haut a droite</li>' +
            '</ol>' +
            '<div style="display:flex;justify-content:flex-end;">' +
            '<button id="pwaIosOk" style="background:#8b4513;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Compris</button>' +
            '</div>' +
            '</div>';
        m.onclick = function(e) { if (e.target === m) m.remove(); };
        document.getElementById('pwaIosOk').onclick = function() { m.remove(); };
    }

    // Si on a reload pour appliquer le nouveau nom, declencher l'install
    // avec un polling actif (jusqu'a 10s) pour attendre beforeinstallprompt.
    window.addEventListener('load', function() {
        try {
            if (sessionStorage.getItem('pwaInstallAfterReload') === '1') {
                sessionStorage.removeItem('pwaInstallAfterReload');
                showToast('Preparation de l\'installation...', 3000);
                _pollInstallPrompt();
            }
            // Reprise du pre-cache Corse choisi avant le reload (le download ne
            // pouvait pas survivre au reload, on le lance maintenant : SW actif).
            var pcChoice = sessionStorage.getItem('pwaPrecacheChoice');
            if (pcChoice === 'light' || pcChoice === 'full') {
                sessionStorage.removeItem('pwaPrecacheChoice');
                setTimeout(function() { _startCorsePrecache(pcChoice); }, 2500);
            }
        } catch(_e) {}
    });

    function _pollInstallPrompt() {
        var maxWait = 10000;
        var interval = 300;
        var elapsed = 0;
        var poll = setInterval(function() {
            elapsed += interval;
            if (_deferredInstallPrompt) {
                clearInterval(poll);
                triggerInstall();
            } else if (elapsed >= maxWait) {
                clearInterval(poll);
                // Pas de prompt natif disponible apres 10s
                if (isPwaInstalled()) {
                    showToast('App deja installee sur l\'ecran d\'accueil.', 5000);
                } else if (isIosSafari()) {
                    showIosInstallModal();
                } else {
                    // Chrome / Android : afficher instructions manuelles
                    alert('L\'installation n\'a pas ete proposee automatiquement.\n\n' +
                          'Pour installer manuellement :\n' +
                          '1. Ouvre le menu Chrome (3 points en haut a droite)\n' +
                          '2. Choisis "Installer l\'application" ou "Ajouter a l\'ecran d\'accueil"\n' +
                          '3. Confirme avec ton nom personnalise');
                }
            }
        }, interval);
    }


    // ===== Affichage des points crees offline =====
    // Layer dedie pour les points en attente de sync. Visible immediatement
    // sur la carte avec un style distinctif (orange + bordure pointillee).
    // Nettoye au retour online apres reload des features Supabase.
    var _offlineLayer = null;

    function _ensureOfflineLayer() {
        if (_offlineLayer) return _offlineLayer;
        var map = findLeafletMap();
        if (!map) return null;
        _offlineLayer = L.layerGroup().addTo(map);
        return _offlineLayer;
    }

    // Restaure les markers offline depuis la queue IndexedDB au reload de la page.
    // Sans ça, les points en attente disparaissent visuellement apres rechargement
    // (ils restent dans la queue mais l'utilisateur ne les voit plus sur la carte).
    function restoreOfflineMarkersFromQueue() {
        var map = findLeafletMap();
        if (!map) {
            // Map pas encore prete : retry differé
            setTimeout(restoreOfflineMarkersFromQueue, 500);
            return;
        }
        dbAll().then(function(items) {
            if (!items || items.length === 0) return;
            var count = 0;
            items.forEach(function(it) {
                if (it.kind !== 'rest' || it.method !== 'POST') return;
                if (!/\/rest\/v1\/custom_features\b/.test(it.url)) return;
                try {
                    var body = it.bodySer && it.bodySer.type === 'string'
                        ? JSON.parse(it.bodySer.value) : null;
                    if (body && body.geometry) {
                        addOfflineFeatureToMap(body);
                        count++;
                    }
                } catch(e) {
                    console.warn('[PWA] Restoration marker offline echoue :', e);
                }
            });
            if (count > 0) {
                console.log('[PWA] ' + count + ' marker(s) offline restaure(s) depuis la queue');
            }
        }).catch(function(e) {
            console.warn('[PWA] dbAll echoue au reload :', e);
        });
    }

    function addOfflineFeatureToMap(body) {
        var map = findLeafletMap();
        var layer = _ensureOfflineLayer();
        if (!map || !layer) return;
        var g = body.geometry;
        var name = body.name || body.nom || 'Point en attente';
        var _ph = body.photo_url || body.photo_url2 || '';
        var _phHtml = _ph
            ? '<br><img src="' + escapeHtml(_ph) + '" alt="photo" style="max-width:180px;max-height:140px;border-radius:6px;margin-top:6px;display:block;" onerror="this.style.display=\'none\'">'
            : '';
        var labelHtml = '<span style="background:#f39c12;color:#fff;padding:2px 6px;border-radius:8px;font-size:10px;font-weight:600;">En attente</span> <strong>' + escapeHtml(name) + '</strong>' + _phHtml;

        if (g.type === 'Point' && g.coordinates) {
            var lat = g.coordinates[1], lon = g.coordinates[0];
            var icon = L.divIcon({
                className: 'pwa-offline-marker',
                html: '<div style="width:22px;height:22px;border-radius:50%;background:#f39c12;border:3px solid #fff;box-shadow:0 0 0 2px #f39c12,0 2px 6px rgba(0,0,0,0.4);position:relative;">' +
                      '<div style="position:absolute;top:-8px;right:-8px;width:14px;height:14px;border-radius:50%;background:#fff;color:#f39c12;font:bold 10px sans-serif;display:flex;align-items:center;justify-content:center;">⏱</div>' +
                      '</div>',
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            });
            var marker = L.marker([lat, lon], { icon: icon, zIndexOffset: 9999 }).addTo(layer);
            marker.bindPopup(labelHtml + '<br><small style="color:#888;">Sera sync au retour reseau</small>');
        } else if (g.type === 'Polygon' && g.coordinates && g.coordinates[0]) {
            var latlngs = g.coordinates[0].map(function(c) { return [c[1], c[0]]; });
            var poly = L.polygon(latlngs, {
                color: '#f39c12', weight: 3, dashArray: '6,6', fillOpacity: 0.2
            }).addTo(layer);
            poly.bindPopup(labelHtml);
        } else if (g.type === 'LineString' && g.coordinates) {
            var lls = g.coordinates.map(function(c) { return [c[1], c[0]]; });
            var line = L.polyline(lls, {
                color: '#f39c12', weight: 4, dashArray: '6,6'
            }).addTo(layer);
            line.bindPopup(labelHtml);
        }
        console.log('[PWA] Point offline ajoute a la carte :', name);
    }

    function clearOfflineLayer() {
        if (_offlineLayer) {
            _offlineLayer.clearLayers();
        }
    }

    // Au sync reussi, nettoyer la couche offline + recharger les vraies features
    // Listener QUEUE_SYNCED deja en place plus haut, on l'enrichit.

    // ===== Toast notification =====
    function showToast(msg, dur) {
        dur = dur || 4000;
        var t = document.createElement('div');
        t.style.cssText =
            'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
            'background:rgba(40,40,40,0.92);color:#fff;padding:10px 18px;' +
            'border-radius:22px;font:600 13px/1.3 Segoe UI,sans-serif;' +
            'box-shadow:0 4px 14px rgba(0,0,0,0.28);z-index:10600;' +
            'max-width:80vw;text-align:center;opacity:0;transition:opacity 0.25s;';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(function() { t.style.opacity = '1'; }, 20);
        setTimeout(function() {
            t.style.opacity = '0';
            setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
        }, dur);
    }

    // ===== Modal detaille des modifs en attente =====
    function openQueueDetailsModal() {
        var existing = document.getElementById('pwaQueueModal');
        if (existing) { existing.remove(); return; }
        var m = document.createElement('div');
        m.id = 'pwaQueueModal';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10500;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);

        m.innerHTML =
            '<div style="background:#fff;border-radius:10px;max-width:600px;width:100%;max-height:85vh;overflow:hidden;display:flex;flex-direction:column;padding:18px 22px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
            '<h2 style="margin:0;font-size:17px;color:#5a3a1a;">Modifications en attente</h2>' +
            '<button id="pwaQClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:#8b7355;">&times;</button>' +
            '</div>' +
            '<div id="pwaQList" style="flex:1;overflow-y:auto;border:1px solid #f0ebe3;border-radius:6px;margin-bottom:10px;"></div>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
            '<button id="pwaQRefresh" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Rafraichir</button>' +
            '<button id="pwaQReplay" style="background:#8b4513;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Tout synchroniser</button>' +
            '</div>' +
            '</div>';
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(m);
            L.DomEvent.disableScrollPropagation(m);
        }
        document.getElementById('pwaQClose').onclick = function() { m.remove(); };
        m.onclick = function(e) { if (e.target === m) m.remove(); };

        function refreshList() {
            dbAll().then(function(items) {
                var list = document.getElementById('pwaQList');
                if (!list) return;
                if (items.length === 0) {
                    list.innerHTML = '<div style="padding:30px 20px;text-align:center;color:#888;font-size:13px;">Aucune modification en attente</div>';
                    return;
                }
                var methodColor = { POST: '#27ae60', PATCH: '#2980b9', DELETE: '#c0392b' };
                list.innerHTML = items.map(function(it) {
                    var ago = humanAge(it.createdAt);
                    var tableMatch = /\/rest\/v1\/([^?]+)/.exec(it.url);
                    var table = tableMatch ? tableMatch[1] : '?';
                    var label = it.summary || ('Operation sur ' + table);
                    return '<div style="padding:10px 12px;border-bottom:1px solid #f0ebe3;display:flex;align-items:center;gap:10px;">' +
                        '<span style="background:' + (methodColor[it.method]||'#888') + ';color:#fff;font-size:10px;padding:3px 8px;border-radius:10px;font-weight:700;">' + it.method + '</span>' +
                        '<div style="flex:1;min-width:0;">' +
                        '<div style="font-size:13px;color:#333;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(label) + '</div>' +
                        '<div style="font-size:10px;color:#888;">' + escapeHtml(table) + ' • il y a ' + ago + (it.attempts > 0 ? ' • ' + it.attempts + ' tentative(s)' : '') + '</div>' +
                        '</div>' +
                        '<button data-del-id="' + it.id + '" title="Supprimer cette modif (sera perdue)" style="background:#fdf0ef;color:#c0392b;border:1px solid #f5c6c0;border-radius:4px;width:28px;height:28px;cursor:pointer;font-size:14px;line-height:1;">×</button>' +
                        '</div>';
                }).join('');
                list.querySelectorAll('button[data-del-id]').forEach(function(btn) {
                    btn.onclick = function() {
                        if (!confirm('Supprimer cette modification ? Elle sera perdue.')) return;
                        dbDel(parseInt(btn.dataset.delId)).then(refreshList).then(updateQueueBadge);
                    };
                });
            });
        }

        document.getElementById('pwaQRefresh').onclick = refreshList;
        document.getElementById('pwaQReplay').onclick = function() {
            if (isAppOffline()) { showToast('Pas de reseau (ou mode test actif)'); return; }
            document.getElementById('pwaQReplay').disabled = true;
            document.getElementById('pwaQReplay').textContent = 'Synchro...';
            replayQueue().then(function() {
                refreshList();
                showToast('Synchro terminee');
                var b = document.getElementById('pwaQReplay');
                if (b) { b.disabled = false; b.textContent = 'Tout synchroniser'; }
            });
        };

        refreshList();
    }

    function humanAge(ts) {
        var s = Math.round((Date.now() - ts) / 1000);
        if (s < 60) return s + ' s';
        var m = Math.round(s / 60);
        if (m < 60) return m + ' min';
        var h = Math.round(m / 60);
        if (h < 48) return h + ' h';
        return Math.round(h / 24) + ' j';
    }

    function escapeHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }


    // ===== API wrapper =====
    function getCacheStats() {
        return new Promise(function(resolve) {
            if (!navigator.serviceWorker.controller) { resolve(null); return; }
            var ch = new MessageChannel();
            ch.port1.onmessage = function(e) { resolve(e.data); };
            navigator.serviceWorker.controller.postMessage({ type: 'CACHE_STATS' }, [ch.port2]);
        });
    }

    function clearCache(wipeContext) {
        return new Promise(function(resolve) {
            if (!navigator.serviceWorker.controller) { resolve(false); return; }
            var ch = new MessageChannel();
            ch.port1.onmessage = function(e) { resolve(e.data && e.data.cleared); };
            navigator.serviceWorker.controller.postMessage(
                { type: 'CLEAR_CACHE', wipeContext: !!wipeContext }, [ch.port2]);
        });
    }

    // Requete generique au SW (resolue avec la reponse)
    function _swRequest(msg) {
        return new Promise(function(resolve) {
            if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
                resolve(null); return;
            }
            var ch = new MessageChannel();
            ch.port1.onmessage = function(e) { resolve(e.data); };
            try { navigator.serviceWorker.controller.postMessage(msg, [ch.port2]); }
            catch(_e) { resolve(null); }
        });
    }

    // Conversion tuile -> coords + bbox d'un batch (pour centrer la carte)
    function _tileToLon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
    function _tileToLat(y, z) {
        var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
        return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    }
    function _parseXYZ(u) {
        try {
            var url = new URL(u);
            if (/data\.geopf\.fr\/wmts/i.test(u)) {
                var z = null, x = null, y = null;
                url.searchParams.forEach(function(v, k) {
                    var kl = k.toLowerCase();
                    if (kl === 'tilematrix') z = parseInt(v, 10);
                    else if (kl === 'tilecol') x = parseInt(v, 10);
                    else if (kl === 'tilerow') y = parseInt(v, 10);
                });
                if (z != null && x != null && y != null) return { z: z, x: x, y: y };
                return null;
            }
            var m = url.pathname.match(/\/tile\/(\d+)\/(\d+)\/(\d+)\/?$/);
            if (m && /arcgisonline/i.test(u)) return { z: +m[1], y: +m[2], x: +m[3] };
            m = url.pathname.match(/\/(\d+)\/(\d+)\/(\d+)\.[a-z0-9]+$/i);
            if (m) return { z: +m[1], x: +m[2], y: +m[3] };
            return null;
        } catch (e) { return null; }
    }
    function _batchBounds(b) {
        if (typeof L === 'undefined') return null;
        if (b && b.kind === 'context') {
            return L.latLngBounds(
                [CORSE_BOUNDS.south, CORSE_BOUNDS.west],
                [CORSE_BOUNDS.north, CORSE_BOUNDS.east]);
        }
        var urls = (b && b.urls) || [];
        if (!urls.length) return null;
        var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity, got = false;
        var step = Math.max(1, Math.ceil(urls.length / 4000));
        for (var i = 0; i < urls.length; i += step) {
            var t = _parseXYZ(urls[i]);
            if (!t) continue;
            var lo1 = _tileToLon(t.x, t.z), lo2 = _tileToLon(t.x + 1, t.z);
            var la1 = _tileToLat(t.y, t.z), la2 = _tileToLat(t.y + 1, t.z);
            minLon = Math.min(minLon, lo1, lo2); maxLon = Math.max(maxLon, lo1, lo2);
            minLat = Math.min(minLat, la1, la2); maxLat = Math.max(maxLat, la1, la2);
            got = true;
        }
        if (!got) return null;
        return L.latLngBounds([minLat, minLon], [maxLat, maxLon]);
    }

    // ===== Modal : gerer / supprimer les caches par DL lance =====
    // Liste chaque pre-cache lance par l'utilisateur (zone, communes, contexte
    // Corse...) + suppression selective. La suppression d'un batch n'efface
    // QUE ses tuiles non partagees avec un batch conserve.
    function openCacheManageModal() {
        var existing = document.getElementById('pwaCacheMgr');
        if (existing) { existing.remove(); return; }
        var m = document.createElement('div');
        m.id = 'pwaCacheMgr';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100060;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);
        m.innerHTML =
            '<div style="background:#fff;border-radius:12px;max-width:520px;width:100%;max-height:88vh;display:flex;flex-direction:column;padding:20px 22px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
            '<h2 style="margin:0;font-size:17px;color:#5a3a1a;">Mes telechargements hors-ligne</h2>' +
            '<button id="pwaCMClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:#8b7355;">&times;</button>' +
            '</div>' +
            '<div id="pwaCMTotal" style="font-size:12px;color:#5a3a1a;background:#faf7f2;border:1px solid #f0ebe3;border-radius:6px;padding:8px 10px;margin-bottom:10px;"></div>' +
            '<div id="pwaCMList" style="flex:1;overflow-y:auto;border:1px solid #f0ebe3;border-radius:6px;padding:6px;min-height:120px;max-height:48vh;font-size:13px;">Chargement...</div>' +
            '<div style="display:flex;gap:8px;justify-content:space-between;margin-top:12px;flex-wrap:wrap;">' +
            '<button id="pwaCMWipeAll" style="background:#fff;color:#c0392b;border:1px solid #e8a8a0;padding:8px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI,sans-serif;">Tout supprimer</button>' +
            '<div style="display:flex;gap:8px;">' +
            '<button id="pwaCMCancel" style="background:#f0ebe3;color:#5a3a1a;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI,sans-serif;">Fermer</button>' +
            '<button id="pwaCMDelete" style="background:#8b4513;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI,sans-serif;" disabled>Supprimer la selection</button>' +
            '</div></div></div>';
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(m);
            L.DomEvent.disableScrollPropagation(m);
        }
        var listEl = m.querySelector('#pwaCMList');
        var delBtn = m.querySelector('#pwaCMDelete');
        function close() { m.remove(); }
        m.querySelector('#pwaCMClose').onclick = close;
        m.querySelector('#pwaCMCancel').onclick = close;
        m.onclick = function(e) { if (e.target === m) close(); };

        function refresh() {
            dbBatchAll().then(function(batches) {
                batches.sort(function(a, b) { return (b.date || 0) - (a.date || 0); });
                var totEl = m.querySelector('#pwaCMTotal');
                var totCount = batches.reduce(function(s, b) { return s + (b.count || 0); }, 0);
                if (totEl) {
                    totEl.innerHTML = '<strong>' + batches.length + ' telechargement(s)</strong> · ' +
                        totCount + ' elements · ~' + (totCount * 0.04).toFixed(0) + ' Mo (estime)';
                }
                if (batches.length === 0) {
                    listEl.innerHTML = '<div style="color:#999;font-style:italic;padding:10px;text-align:center;">Aucun telechargement enregistre.</div>';
                    if (totEl) totEl.innerHTML = 'Aucun telechargement hors-ligne enregistre.';
                    delBtn.disabled = true;
                    return;
                }
                listEl.innerHTML = batches.map(function(b) {
                    var mo = ((b.count || 0) * 0.04).toFixed(b.count > 250 ? 0 : 1);
                    var dt = b.date ? new Date(b.date).toLocaleDateString('fr-FR') +
                        ' ' + new Date(b.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
                    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 6px;border-bottom:1px solid #f4efe7;">' +
                        '<label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer;">' +
                        '<input type="checkbox" class="pwaCMcb" data-id="' + b.id + '">' +
                        '<span style="flex:1;">' +
                        '<strong>' + escapeHtml(b.label || b.id) + '</strong>' +
                        (b.kind === 'context' ? ' <span style="color:#16a085;font-size:10px;">(contexte, preserve au vidage)</span>' : '') +
                        '<br><span style="color:#999;font-size:11px;">' + (b.count || 0) + ' elements · ~' + mo + ' Mo · ' + dt + '</span>' +
                        '</span></label>' +
                        '<button class="pwaCMfocus" data-id="' + b.id + '" style="flex:none;background:#f0ebe3;color:#5a3a1a;border:none;border-radius:6px;padding:6px 10px;font:600 11px Segoe UI;cursor:pointer;">Centrer</button>' +
                        '</div>';
                }).join('');
                listEl.querySelectorAll('input.pwaCMcb').forEach(function(cb) {
                    cb.onchange = function() {
                        delBtn.disabled = listEl.querySelectorAll('input.pwaCMcb:checked').length === 0;
                    };
                });
                listEl.querySelectorAll('button.pwaCMfocus').forEach(function(fb) {
                    fb.onclick = function() {
                        var b = batches.filter(function(x) { return x.id === fb.dataset.id; })[0];
                        if (!b) return;
                        var bnds = _batchBounds(b);
                        if (!bnds) { showToast('Zone indeterminee pour ce telechargement.', 4000); return; }
                        var mp = findLeafletMap();
                        if (!mp) { showToast('Carte non detectee.', 3000); return; }
                        close();
                        try { mp.fitBounds(bnds, { padding: [40, 40] }); } catch(_e) {}
                    };
                });
                delBtn.disabled = true;
            });
        }
        refresh();

        delBtn.onclick = function() {
            var ids = [];
            listEl.querySelectorAll('input.pwaCMcb:checked').forEach(function(cb) { ids.push(cb.dataset.id); });
            if (ids.length === 0) return;
            delBtn.disabled = true;
            delBtn.textContent = 'Suppression...';
            dbBatchAll().then(function(batches) {
                var sel = {}; ids.forEach(function(i) { sel[i] = true; });
                var selected = batches.filter(function(b) { return sel[b.id]; });
                var kept = batches.filter(function(b) { return !sel[b.id]; });
                // URLs a conserver = union des batches NON selectionnes (tuiles)
                var keepSet = {};
                kept.forEach(function(b) {
                    if (b.kind !== 'context' && b.urls) b.urls.forEach(function(u) { keepSet[u] = 1; });
                });
                // URLs a supprimer = (selectionnes tuiles) - keepSet
                var delSet = {};
                var hasContextSel = false;
                selected.forEach(function(b) {
                    if (b.kind === 'context') { hasContextSel = true; return; }
                    (b.urls || []).forEach(function(u) { if (!keepSet[u]) delSet[u] = 1; });
                });
                var delUrls = Object.keys(delSet);
                var ops = [];
                if (delUrls.length) ops.push(_swRequest({ type: 'DELETE_URLS', urls: delUrls }));
                if (hasContextSel) {
                    ops.push(_swRequest({ type: 'DELETE_CACHES', keys: ['context'] }));
                    _setCorseContextLevel('');
                }
                Promise.all(ops).then(function() {
                    return Promise.all(selected.map(function(b) { return dbBatchDel(b.id); }));
                }).then(function() {
                    return dbBatchAll();
                }).then(function(remaining) {
                    // Plus aucun telechargement -> retirer le contour de zone
                    // (il vient du localStorage, independant du cache).
                    if (!remaining || remaining.length === 0) {
                        try { clearStoredZone(); } catch(_e) {}
                        try { hidePrecachedZoneOnMap(); } catch(_e) {}
                    }
                    showToast(selected.length + ' telechargement(s) supprime(s)'
                        + (delUrls.length ? ' (' + delUrls.length + ' tuiles)' : ''), 5000);
                    delBtn.textContent = 'Supprimer la selection';
                    refresh();
                });
            });
        };

        m.querySelector('#pwaCMWipeAll').onclick = function() {
            if (!confirm('Tout supprimer : TOUS les caches (tuiles, contexte Corse, photos, donnees). La carte ne sera plus disponible hors-ligne tant qu\'elle n\'est pas rechargee en ligne. Continuer ?')) return;
            clearCache(true).then(function() {
                _setCorseContextLevel('');
                // Retirer le contour de zone (localStorage, hors cache)
                try { clearStoredZone(); } catch(_e) {}
                try { hidePrecachedZoneOnMap(); } catch(_e) {}
                return dbBatchAll();
            }).then(function(batches) {
                return Promise.all(batches.map(function(b) { return dbBatchDel(b.id); }));
            }).then(function() {
                showToast('Tous les caches supprimes.', 5000);
                close();
            });
        };
    }

    // ============================================================
    //  ENREGISTREMENT DE PARCOURS DE MARCHE (GPS track)
    //  Client pur, hors-ligne. Multi-parcours, GPX, Wake Lock,
    //  pause/reprise, stats, persistance incrementale + reprise.
    // ============================================================
    var _trk = null;            // parcours actif en memoire
    var _trkWatch = null;       // id watchPosition
    var _trkPoly = null;        // polyline live
    var _trkWake = null;        // WakeLockSentinel
    var _trkWakeOk = false;     // verrou ecran reellement actif ?
    var _trkWakeWarned = false; // avertissement deja affiche ?
    var _trkSaveCount = 0;      // throttle persistance
    var _trkTick = null;        // interval maj widget
    var _trkLastTickTs = 0;     // pour cumuler la duree active

    function _trkHaversine(aLat, aLon, bLat, bLon) {
        var R = 6371000, toR = Math.PI / 180;
        var dLat = (bLat - aLat) * toR, dLon = (bLon - aLon) * toR;
        var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(aLat * toR) * Math.cos(bLat * toR) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    }
    function _trkFmtDist(m) {
        return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
    }
    function _trkFmtDur(ms) {
        var s = Math.floor(ms / 1000);
        var h = Math.floor(s / 3600), mn = Math.floor((s % 3600) / 60), se = s % 60;
        return (h > 0 ? h + 'h' : '') + (mn < 10 && h > 0 ? '0' : '') + mn + 'm'
            + (se < 10 ? '0' : '') + se + 's';
    }

    function _trkWakeWarn() {
        if (_trkWakeWarned) return;
        _trkWakeWarned = true;
        showToast('Verrou ecran indisponible : regler le delai de mise en veille du '
            + 'telephone sur long/jamais et desactiver l\'economie de batterie '
            + 'pendant l\'enregistrement (sinon verrouillage auto -> GPS suspendu).', 9000);
    }
    function _trkAcquireWake() {
        if (!(navigator.wakeLock && navigator.wakeLock.request)) {
            _trkWakeOk = false;
            if (_trk && _trk.status === 'recording') _trkWakeWarn();
            return;
        }
        try {
            navigator.wakeLock.request('screen').then(function(s) {
                _trkWake = s;
                _trkWakeOk = true;
                s.addEventListener('release', function() {
                    _trkWake = null;
                    _trkWakeOk = false;
                    // Release systeme (economie batterie...) : re-tenter si
                    // l'enregistrement continue et la page est visible.
                    if (_trk && _trk.status === 'recording'
                        && document.visibilityState === 'visible') {
                        setTimeout(_trkAcquireWake, 1500);
                    }
                });
            }).catch(function() {
                _trkWakeOk = false;
                if (_trk && _trk.status === 'recording') _trkWakeWarn();
            });
        } catch(_e) {
            _trkWakeOk = false;
        }
    }
    function _trkReleaseWake() {
        try { if (_trkWake) { _trkWake.release(); _trkWake = null; } } catch(_e) {}
    }
    document.addEventListener('visibilitychange', function() {
        // Le Wake Lock est libere quand la page passe en arriere-plan :
        // le re-acquerir au retour si un enregistrement est en cours.
        if (document.visibilityState === 'visible' && _trk && _trk.status === 'recording') {
            _trkAcquireWake();
        }
    });

    function _trkPersist(force) {
        if (!_trk) return;
        _trkSaveCount++;
        if (!force && _trkSaveCount % 8 !== 0) return;  // throttle (~1 sur 8 points)
        dbTrackPut(_trk).catch(function(e) { console.warn('[Track] persist:', e); });
    }

    function _trkEnsurePoly() {
        var map = findLeafletMap();
        if (!map) return null;
        if (!_trkPoly) {
            _trkPoly = L.polyline([], {
                color: '#e74c3c', weight: 5, opacity: 0.9, lineJoin: 'round'
            }).addTo(map);
        }
        return _trkPoly;
    }

    function _trkOnPos(pos) {
        if (!_trk || _trk.status !== 'recording') return;
        var c = pos.coords;
        if (c.accuracy == null || c.accuracy > 40) return;  // point trop imprecis
        var now = Date.now();
        var pts = _trk.points;
        var last = pts.length ? pts[pts.length - 1] : null;
        if (last) {
            var d = _trkHaversine(last.lat, last.lon, c.latitude, c.longitude);
            var dt = (now - last.t) / 1000;
            // Filtre jitter immobile + saut GPS aberrant (>45 m/s)
            if (d < Math.max(3, c.accuracy * 0.5)) { _trk._lastSeen = now; return; }
            if (dt > 0 && d / dt > 45) return;
            _trk.distance += d;
        }
        pts.push({
            lat: c.latitude, lon: c.longitude, t: now,
            alt: (c.altitude != null ? Math.round(c.altitude) : null),
            acc: Math.round(c.accuracy)
        });
        // Denivele positif (seuil anti-bruit 2 m)
        if (last && last.alt != null && c.altitude != null) {
            var da = c.altitude - last.alt;
            if (da > 2) _trk.gain = (_trk.gain || 0) + da;
        }
        var poly = _trkEnsurePoly();
        if (poly) poly.addLatLng([c.latitude, c.longitude]);
        _trkPersist(false);
    }

    function _trkOnErr(e) {
        console.warn('[Track] geoloc error:', e && e.message);
    }

    function _trkStartWatch() {
        if (!navigator.geolocation) {
            showToast('Geolocalisation indisponible sur cet appareil.', 5000);
            return false;
        }
        _trkWatch = navigator.geolocation.watchPosition(_trkOnPos, _trkOnErr, {
            enableHighAccuracy: true, maximumAge: 0, timeout: 30000
        });
        return true;
    }
    function _trkStopWatch() {
        if (_trkWatch != null) {
            try { navigator.geolocation.clearWatch(_trkWatch); } catch(_e) {}
            _trkWatch = null;
        }
    }

    function _trkStart() {
        if (_trk && _trk.status !== 'done') {
            showToast('Un parcours est deja en cours.', 4000);
            return;
        }
        var d = new Date();
        _trk = {
            id: 'trk-' + d.getTime(),
            name: 'Parcours du ' + d.toLocaleDateString('fr-FR') + ' '
                + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
            startedAt: d.getTime(), endedAt: null,
            points: [], distance: 0, gain: 0,
            activeMs: 0, status: 'recording'
        };
        _trkLastTickTs = Date.now();
        if (!_trkStartWatch()) { _trk = null; return; }
        _trkAcquireWake();
        _trkPoly = null;
        _trkShowWidget();
        _trkStartTick();
        _trkPersist(true);
        showToast('Enregistrement du parcours demarre. Ecran maintenu allume.', 4000);
    }
    function _trkPause() {
        if (!_trk || _trk.status !== 'recording') return;
        _trk.activeMs += Date.now() - _trkLastTickTs;
        _trk.status = 'paused';
        _trkStopWatch();
        _trkReleaseWake();
        _trkExitEco();
        _trkUpdateWidget();
        _trkPersist(true);
    }
    function _trkResume() {
        if (!_trk || _trk.status !== 'paused') return;
        _trk.status = 'recording';
        _trkLastTickTs = Date.now();
        _trkStartWatch();
        _trkAcquireWake();
        _trkUpdateWidget();
        _trkPersist(true);
    }
    function _trkStop() {
        if (!_trk) return;
        if (_trk.status === 'recording') _trk.activeMs += Date.now() - _trkLastTickTs;
        _trk.status = 'done';
        _trk.endedAt = Date.now();
        _trkStopWatch();
        _trkReleaseWake();
        _trkExitEco();
        _trkStopTick();
        var saved = _trk;
        _trkPersist(true);
        _trkHideWidget();
        if (_trkPoly) { try { findLeafletMap().removeLayer(_trkPoly); } catch(_e) {} _trkPoly = null; }
        _trk = null;
        showToast('Parcours enregistre : ' + _trkFmtDist(saved.distance)
            + ' en ' + _trkFmtDur(saved.activeMs) + '.', 6000);
        _trkOpenManager(saved.id);
    }

    function _trkActiveDuration() {
        if (!_trk) return 0;
        return _trk.activeMs + (_trk.status === 'recording'
            ? (Date.now() - _trkLastTickTs) : 0);
    }

    // --- Widget enregistreur flottant ---
    function _trkShowWidget() {
        _trkHideWidget();
        if (!document.getElementById('pwaGeoSpinStyle')) {
            var st = document.createElement('style');
            st.id = 'pwaGeoSpinStyle';
            st.textContent = '@keyframes pwaGeoSpin{to{transform:rotate(360deg)}}';
            document.head.appendChild(st);
        }
        var w = document.createElement('div');
        w.id = 'pwaTrkWidget';
        w.style.cssText =
            'position:fixed !important;top:12px !important;left:50% !important;' +
            'transform:translateX(-50%);z-index:100075 !important;' +
            'background:rgba(30,30,30,0.96);color:#fff;border-radius:14px;' +
            'box-shadow:0 4px 16px rgba(0,0,0,0.35);font:600 12px Segoe UI,sans-serif;' +
            'padding:8px 12px;display:flex;align-items:center;justify-content:center;' +
            'flex-wrap:wrap;gap:8px 10px;max-width:94vw;box-sizing:border-box;';
        (document.body || document.documentElement).appendChild(w);
        _trkUpdateWidget();
    }
    function _trkUpdateWidget() {
        var w = document.getElementById('pwaTrkWidget');
        if (!w || !_trk) return;
        var rec = _trk.status === 'recording';
        var dur = _trkActiveDuration();
        var dist = _trk.distance || 0;
        var spd = dur > 0 ? (dist / (dur / 1000)) * 3.6 : 0;  // km/h moyen
        w.innerHTML =
            '<span style="display:inline-flex;align-items:center;gap:6px;">' +
            '<span style="width:10px;height:10px;border-radius:50%;background:' +
            (rec ? '#e74c3c' : '#f39c12') + ';' + (rec ? 'animation:pwaGeoSpin 1.4s linear infinite;' : '') + '"></span>' +
            (rec ? 'Enregistrement' : 'En pause') + '</span>' +
            '<span>' + _trkFmtDist(dist) + '</span>' +
            '<span>' + _trkFmtDur(dur) + '</span>' +
            '<span>' + spd.toFixed(1) + ' km/h</span>' +
            (rec
                ? '<button id="pwaTrkPause" style="background:#f39c12;color:#fff;border:none;border-radius:8px;padding:5px 10px;font:600 11px Segoe UI;cursor:pointer;">Pause</button>'
                : '<button id="pwaTrkResume" style="background:#27ae60;color:#fff;border:none;border-radius:8px;padding:5px 10px;font:600 11px Segoe UI;cursor:pointer;">Reprendre</button>') +
            (rec ? '<button id="pwaTrkEco" style="background:#34495e;color:#fff;border:none;border-radius:8px;padding:5px 10px;font:600 11px Segoe UI;cursor:pointer;">Veille eco</button>' : '') +
            '<button id="pwaTrkStop" style="background:#c0392b;color:#fff;border:none;border-radius:8px;padding:5px 10px;font:600 11px Segoe UI;cursor:pointer;">Arreter</button>';
        var pb = document.getElementById('pwaTrkPause');
        if (pb) pb.onclick = _trkPause;
        var rb = document.getElementById('pwaTrkResume');
        if (rb) rb.onclick = _trkResume;
        var eb = document.getElementById('pwaTrkEco');
        if (eb) eb.onclick = _trkEnterEco;
        var sb = document.getElementById('pwaTrkStop');
        if (sb) sb.onclick = function() {
            if (confirm('Arreter et enregistrer ce parcours ?')) _trkStop();
        };
    }

    // ===== Mode veille eco : ecran quasi-noir (OLED ~= eteint) =====
    // L'enregistrement continue dessous (watch + Wake Lock inchanges). Sur
    // ecran OLED/AMOLED le noir consomme quasi rien. Tap = retour a la carte.
    var _trkEcoEl = null;
    function _trkEnterEco() {
        if (_trkEcoEl) return;
        _trkEcoEl = document.createElement('div');
        _trkEcoEl.id = 'pwaTrkEco';
        _trkEcoEl.style.cssText =
            'position:fixed !important;inset:0 !important;z-index:2000000 !important;' +
            'background:#000 !important;color:#1c1c1c;' +
            'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
            'gap:18px;font:600 13px Segoe UI,sans-serif;-webkit-tap-highlight-color:transparent;' +
            'user-select:none;text-align:center;';
        _trkEcoEl.innerHTML =
            '<div id="pwaTrkEcoTxt" style="color:#222;font-size:15px;line-height:2;"></div>' +
            '<div id="pwaTrkEcoSlide" style="position:relative;width:78vw;max-width:320px;' +
            'height:54px;border-radius:27px;background:#0e0e0e;border:1px solid #1c1c1c;' +
            'overflow:hidden;touch-action:none;">' +
            '<div style="position:absolute;inset:0;display:flex;align-items:center;' +
            'justify-content:center;color:#2a2a2a;font:600 12px Segoe UI;letter-spacing:1px;">' +
            'Glisser pour revenir &gt;&gt;&gt;</div>' +
            '<div id="pwaTrkEcoKnob" style="position:absolute;left:3px;top:3px;width:46px;' +
            'height:46px;border-radius:50%;background:#262626;color:#555;display:flex;' +
            'align-items:center;justify-content:center;font:700 18px Segoe UI;">&#9654;</div>' +
            '</div>';
        // Sortie par GLISSEMENT du curseur d'un bord a l'autre (deverrouillage).
        // Doit DEMARRER sur le curseur + glisser en continu jusqu'au bout :
        // un effleurement / contact en poche ne peut pas le declencher.
        var _drag = false, _grab = 0;
        function _slideEls() {
            return {
                tr: _trkEcoEl.querySelector('#pwaTrkEcoSlide'),
                kn: _trkEcoEl.querySelector('#pwaTrkEcoKnob')
            };
        }
        function _maxX() {
            var e = _slideEls();
            return e.tr ? (e.tr.offsetWidth - e.kn.offsetWidth - 6) : 0;
        }
        function _setKnob(x) {
            var e = _slideEls();
            if (e.kn) e.kn.style.left = x + 'px';
        }
        function _resetKnob() {
            var e = _slideEls();
            if (e.kn) {
                e.kn.style.transition = 'left .2s';
                e.kn.style.left = '3px';
                setTimeout(function() { if (e.kn) e.kn.style.transition = ''; }, 220);
            }
        }
        function _pStart(clientX, target) {
            var e = _slideEls();
            if (!e.kn || (target !== e.kn && !e.kn.contains(target))) return;
            _drag = true;
            _grab = clientX - parseFloat(e.kn.style.left || '3');
        }
        function _pMove(clientX) {
            if (!_drag) return;
            var mx = _maxX();
            var x = Math.max(3, Math.min(mx, clientX - _grab));
            _setKnob(x);
            if (x >= mx - 2) { _drag = false; _trkExitEco(); }
        }
        function _pEnd() {
            if (_drag) { _drag = false; _resetKnob(); }
        }
        _trkEcoEl.addEventListener('touchstart', function(e) {
            e.preventDefault();
            var t = e.touches && e.touches[0];
            if (t) _pStart(t.clientX, e.target);
        }, { passive: false });
        _trkEcoEl.addEventListener('touchmove', function(e) {
            e.preventDefault();
            var t = e.touches && e.touches[0];
            if (t) _pMove(t.clientX);
        }, { passive: false });
        _trkEcoEl.addEventListener('touchend', _pEnd);
        _trkEcoEl.addEventListener('touchcancel', _pEnd);
        _trkEcoEl.addEventListener('mousedown', function(e) { _pStart(e.clientX, e.target); });
        _trkEcoEl.addEventListener('mousemove', function(e) { _pMove(e.clientX); });
        _trkEcoEl.addEventListener('mouseup', _pEnd);
        _trkEcoEl.addEventListener('mouseleave', _pEnd);
        (document.body || document.documentElement).appendChild(_trkEcoEl);
        // Plein ecran : masque la barre d'URL / chrome du navigateur.
        // Le clic sur "Veille eco" est un geste utilisateur -> autorise.
        try {
            var rfs = _trkEcoEl.requestFullscreen || _trkEcoEl.webkitRequestFullscreen
                || _trkEcoEl.mozRequestFullScreen || _trkEcoEl.msRequestFullscreen;
            if (rfs) { var p = rfs.call(_trkEcoEl); if (p && p.catch) p.catch(function(){}); }
        } catch(_e) {}
        _trkAcquireWake();           // s'assurer que l'ecran reste alloue
        _trkUpdateEco();
        showToast('Veille eco : ecran noir, glisser le curseur pour revenir.', 4000);
    }
    function _trkExitEco() {
        try {
            var d = document;
            if (d.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement) {
                var efs = d.exitFullscreen || d.webkitExitFullscreen
                    || d.mozCancelFullScreen || d.msExitFullscreen;
                if (efs) { var pe = efs.call(d); if (pe && pe.catch) pe.catch(function(){}); }
            }
        } catch(_e) {}
        if (_trkEcoEl && _trkEcoEl.parentNode) _trkEcoEl.parentNode.removeChild(_trkEcoEl);
        _trkEcoEl = null;
    }
    function _trkUpdateEco() {
        if (!_trkEcoEl || !_trk) return;
        var t = document.getElementById('pwaTrkEcoTxt');
        if (!t) return;
        var dur = _trkActiveDuration();
        var dist = _trk.distance || 0;
        t.innerHTML = (_trk.status === 'recording' ? 'Enregistrement' : 'En pause')
            + '<br>' + _trkFmtDist(dist) + '<br>' + _trkFmtDur(dur)
            + (_trkWakeOk ? ''
               : '<br><span style="color:#5a2a00;font-size:11px;">verrou ecran inactif '
                 + '— risque de mise en veille auto</span>');
    }
    function _trkHideWidget() {
        var w = document.getElementById('pwaTrkWidget');
        if (w && w.parentNode) w.parentNode.removeChild(w);
    }
    function _trkStartTick() {
        _trkStopTick();
        _trkTick = setInterval(function() {
            _trkUpdateWidget();
            _trkUpdateEco();
        }, 1000);
    }
    function _trkStopTick() {
        if (_trkTick) { clearInterval(_trkTick); _trkTick = null; }
    }

    // --- Affichage d'un parcours sauvegarde sur la carte ---
    var _trkViewLayer = null;
    function _trkViewOnMap(track) {
        var map = findLeafletMap();
        if (!map || !track || !track.points || track.points.length < 2) {
            showToast('Parcours vide ou carte indisponible.', 4000);
            return;
        }
        if (_trkViewLayer) { try { map.removeLayer(_trkViewLayer); } catch(_e) {} }
        var latlngs = track.points.map(function(p) { return [p.lat, p.lon]; });
        _trkViewLayer = L.polyline(latlngs, {
            color: '#8e44ad', weight: 5, opacity: 0.9
        }).addTo(map);
        try { map.fitBounds(_trkViewLayer.getBounds(), { padding: [40, 40] }); } catch(_e) {}
    }

    // --- Export GPX ---
    function _trkExportGpx(track) {
        if (!track || !track.points || !track.points.length) {
            showToast('Parcours vide.', 3000); return;
        }
        var esc = function(s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        };
        var gpx = '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<gpx version="1.1" creator="Toponymie Corse" xmlns="http://www.topografix.com/GPX/1/1">\n' +
            '<trk><name>' + esc(track.name) + '</name><trkseg>\n';
        track.points.forEach(function(p) {
            gpx += '<trkpt lat="' + p.lat + '" lon="' + p.lon + '">'
                + (p.alt != null ? '<ele>' + p.alt + '</ele>' : '')
                + '<time>' + new Date(p.t).toISOString() + '</time></trkpt>\n';
        });
        gpx += '</trkseg></trk></gpx>\n';
        var blob = new Blob([gpx], { type: 'application/gpx+xml' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (track.name || 'parcours').replace(/[^\w\- ]+/g, '_') + '.gpx';
        document.body.appendChild(a);
        a.click();
        setTimeout(function() {
            URL.revokeObjectURL(a.href);
            if (a.parentNode) a.parentNode.removeChild(a);
        }, 1500);
    }

    // --- Partage du parcours sur la carte collaborative (Supabase) ---
    // Le parcours devient un custom_features de type 'polyline' (LineString),
    // visible par tous les utilisateurs de cette carte. Passe par le wrapper
    // fetch : hors-ligne -> mis en file et synchronise au retour reseau.
    function _trkSimplify(points, maxN) {
        if (!points || points.length <= maxN) return points || [];
        var step = Math.ceil(points.length / maxN);
        var out = [];
        for (var i = 0; i < points.length; i += step) out.push(points[i]);
        if (out[out.length - 1] !== points[points.length - 1]) {
            out.push(points[points.length - 1]);
        }
        return out;
    }
    function _trkShare(track, done) {
        if (!track || !track.points || track.points.length < 2) {
            showToast('Parcours trop court pour etre partage.', 4000);
            return;
        }
        var SU = window.SUPABASE_URL, SK = window.SUPABASE_KEY;
        if (!SU || !SK) {
            showToast('Partage indisponible (configuration Supabase absente).', 5000);
            return;
        }
        if (track.shared) {
            if (!confirm('Ce parcours a deja ete partage. Le partager a nouveau (doublon) ?')) return;
        } else if (!confirm('Partager ce parcours sur la carte collaborative ?\n\n'
                + track.name + '\n' + _trkFmtDist(track.distance || 0)
                + ' · ' + _trkFmtDur(track.activeMs || 0)
                + '\n\nVisible par tous les utilisateurs de cette carte.')) {
            return;
        }
        var pts = _trkSimplify(track.points, 1500);
        var coords = pts.map(function(p) { return [p.lon, p.lat]; });
        var desc = 'Parcours GPS · ' + _trkFmtDist(track.distance || 0)
            + ' · ' + _trkFmtDur(track.activeMs || 0)
            + (track.gain ? ' · D+ ' + Math.round(track.gain) + ' m' : '')
            + ' · ' + (track.points.length) + ' points'
            + ' · ' + new Date(track.startedAt || Date.now()).toLocaleDateString('fr-FR');
        var body = {
            projet_id: (window.DRAWING_PROJET_ID || window.PROJET_ID || null),
            feature_type: 'polyline',
            geometry: { type: 'LineString', coordinates: coords },
            name: track.name,
            description: desc,
            category: 'Parcours',
            color: '#e67e22',
            auteur: (window.CONTRIBUTEUR || window.contributeurActuel || 'Parcours GPS')
        };
        try {
            if (typeof window._mapHash === 'function') {
                body.created_on_carte_hash = window._mapHash();
            }
        } catch(_e) {}
        showToast('Envoi du parcours...', 3000);
        fetch(SU + '/rest/v1/custom_features', {
            method: 'POST',
            headers: {
                'apikey': SK, 'Authorization': 'Bearer ' + SK,
                'Content-Type': 'application/json', 'Prefer': 'return=minimal'
            },
            body: JSON.stringify(body)
        }).then(function(r) {
            if (r && (r.ok || r.status === 201 || r.status === 204)) {
                track.shared = true;
                dbTrackPut(track);
                showToast('Parcours partage sur la carte.', 5000);
                if (typeof window.loadCustomFeatures === 'function') {
                    setTimeout(function() { window.loadCustomFeatures(); }, 600);
                }
            } else if (r && r.status === 202) {
                // wrapper offline : mis en file
                track.shared = true;
                dbTrackPut(track);
                showToast('Hors-ligne : parcours mis en file, partage au retour reseau.', 6000);
            } else {
                showToast('Echec du partage (HTTP ' + (r ? r.status : '?') + ').', 6000);
            }
            if (typeof done === 'function') done();
        }).catch(function(e) {
            showToast('Echec du partage : ' + (e && e.message ? e.message : 'erreur reseau'), 6000);
        });
    }

    // --- Modale gestion des parcours ---
    function _trkOpenManager(highlightId) {
        var existing = document.getElementById('pwaTrkMgr');
        if (existing) existing.remove();
        var m = document.createElement('div');
        m.id = 'pwaTrkMgr';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100060;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);
        m.innerHTML =
            '<div style="background:#fff;border-radius:12px;max-width:540px;width:100%;max-height:88vh;display:flex;flex-direction:column;padding:20px 22px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
            '<h2 style="margin:0;font-size:17px;color:#5a3a1a;">Mes parcours</h2>' +
            '<button id="pwaTrkClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:#8b7355;">&times;</button>' +
            '</div>' +
            '<button id="pwaTrkNew" style="background:#8b4513;color:#fff;border:none;padding:10px 14px;border-radius:8px;cursor:pointer;font:600 13px Segoe UI;margin-bottom:12px;">Demarrer un nouveau parcours</button>' +
            '<div id="pwaTrkList" style="flex:1;overflow-y:auto;border:1px solid #f0ebe3;border-radius:6px;padding:6px;min-height:120px;max-height:55vh;font-size:13px;">Chargement...</div>' +
            '</div>';
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(m);
            L.DomEvent.disableScrollPropagation(m);
        }
        function close() { m.remove(); }
        m.querySelector('#pwaTrkClose').onclick = close;
        m.onclick = function(e) { if (e.target === m) close(); };
        m.querySelector('#pwaTrkNew').onclick = function() {
            close();
            _trkStart();
        };
        var listEl = m.querySelector('#pwaTrkList');
        function refresh() {
            dbTrackAll().then(function(tracks) {
                tracks.sort(function(a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
                if (!tracks.length) {
                    listEl.innerHTML = '<div style="color:#999;font-style:italic;padding:10px;text-align:center;">Aucun parcours enregistre.</div>';
                    return;
                }
                listEl.innerHTML = tracks.map(function(t) {
                    var hl = (t.id === highlightId) ? 'background:#fdf6ec;' : '';
                    var st = t.status !== 'done' ? ' <span style="color:#e67e22;">(interrompu)</span>' : '';
                    if (t.shared) st += ' <span style="color:#16a085;">(partage)</span>';
                    return '<div data-id="' + t.id + '" style="border-bottom:1px solid #f4efe7;padding:8px 6px;' + hl + '">' +
                        '<div style="font-weight:600;color:#5a3a1a;">' + escapeHtml(t.name) + st + '</div>' +
                        '<div style="color:#999;font-size:11px;margin:2px 0 6px;">' +
                        _trkFmtDist(t.distance || 0) + ' · ' + _trkFmtDur(t.activeMs || 0) +
                        ' · ' + (t.points ? t.points.length : 0) + ' pts' +
                        (t.gain ? ' · D+ ' + Math.round(t.gain) + ' m' : '') + '</div>' +
                        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                        '<button class="pwaTrkView" data-id="' + t.id + '" style="background:#f0ebe3;color:#5a3a1a;border:none;border-radius:6px;padding:5px 9px;font:600 11px Segoe UI;cursor:pointer;">Voir sur la carte</button>' +
                        '<button class="pwaTrkRen" data-id="' + t.id + '" style="background:#f0ebe3;color:#5a3a1a;border:none;border-radius:6px;padding:5px 9px;font:600 11px Segoe UI;cursor:pointer;">Renommer</button>' +
                        '<button class="pwaTrkGpx" data-id="' + t.id + '" style="background:#f0ebe3;color:#5a3a1a;border:none;border-radius:6px;padding:5px 9px;font:600 11px Segoe UI;cursor:pointer;">Export GPX</button>' +
                        '<button class="pwaTrkShare" data-id="' + t.id + '" style="background:#8b4513;color:#fff;border:none;border-radius:6px;padding:5px 9px;font:600 11px Segoe UI;cursor:pointer;">Partager</button>' +
                        (t.status !== 'done' ? '<button class="pwaTrkResumeT" data-id="' + t.id + '" style="background:#27ae60;color:#fff;border:none;border-radius:6px;padding:5px 9px;font:600 11px Segoe UI;cursor:pointer;">Reprendre</button>' : '') +
                        '<button class="pwaTrkDel" data-id="' + t.id + '" style="background:#fff;color:#c0392b;border:1px solid #e8a8a0;border-radius:6px;padding:5px 9px;font:600 11px Segoe UI;cursor:pointer;">Supprimer</button>' +
                        '</div></div>';
                }).join('');
                listEl.querySelectorAll('.pwaTrkView').forEach(function(b) {
                    b.onclick = function() {
                        dbTrackGet(b.dataset.id).then(function(t) { close(); _trkViewOnMap(t); });
                    };
                });
                listEl.querySelectorAll('.pwaTrkGpx').forEach(function(b) {
                    b.onclick = function() { dbTrackGet(b.dataset.id).then(_trkExportGpx); };
                });
                listEl.querySelectorAll('.pwaTrkShare').forEach(function(b) {
                    b.onclick = function() {
                        dbTrackGet(b.dataset.id).then(function(t) {
                            if (t) _trkShare(t, refresh);
                        });
                    };
                });
                listEl.querySelectorAll('.pwaTrkRen').forEach(function(b) {
                    b.onclick = function() {
                        dbTrackGet(b.dataset.id).then(function(t) {
                            if (!t) return;
                            var nn = prompt('Nom du parcours :', t.name);
                            if (nn && nn.trim()) {
                                t.name = nn.trim();
                                dbTrackPut(t).then(refresh);
                            }
                        });
                    };
                });
                listEl.querySelectorAll('.pwaTrkDel').forEach(function(b) {
                    b.onclick = function() {
                        if (!confirm('Supprimer ce parcours definitivement ?')) return;
                        dbTrackDel(b.dataset.id).then(refresh);
                    };
                });
                listEl.querySelectorAll('.pwaTrkResumeT').forEach(function(b) {
                    b.onclick = function() {
                        dbTrackGet(b.dataset.id).then(function(t) {
                            if (!t) return;
                            close();
                            _trk = t; _trk.status = 'paused';
                            _trkLastTickTs = Date.now();
                            _trkShowWidget(); _trkStartTick();
                            _trkResume();
                        });
                    };
                });
            });
        }
        refresh();
    }

    // --- Reprise apres reload si un parcours etait en cours ---
    function _trkRecoverOnLoad() {
        dbTrackAll().then(function(tracks) {
            var live = tracks.filter(function(t) { return t.status !== 'done'; })
                .sort(function(a, b) { return (b.startedAt || 0) - (a.startedAt || 0); })[0];
            if (!live) return;
            setTimeout(function() {
                var go = confirm('Un parcours interrompu a ete trouve ('
                    + _trkFmtDist(live.distance || 0) + ', '
                    + (live.points ? live.points.length : 0) + ' points).\n\n'
                    + 'OK = reprendre l\'enregistrement\n'
                    + 'Annuler = le conserver tel quel (consultable dans Mes parcours)');
                if (go) {
                    _trk = live; _trk.status = 'paused';
                    _trkLastTickTs = Date.now();
                    _trkShowWidget(); _trkStartTick();
                    _trkResume();
                } else {
                    live.status = 'done';
                    dbTrackPut(live);
                }
            }, 2500);
        });
    }
    window.addEventListener('load', function() {
        setTimeout(_trkRecoverOnLoad, 1800);
    });

    function openTracksFeature() { _trkOpenManager(); }
    window._pwaTracks = openTracksFeature;

    // ===== Partage de ma position =====
    // Acquisition GPS ponctuelle (haute precision).
    function _getPositionOnce(onOk) {
        if (!navigator.geolocation) {
            showToast('Geolocalisation indisponible sur cet appareil.', 5000);
            return;
        }
        showToast('Acquisition de la position...', 3000);
        navigator.geolocation.getCurrentPosition(
            function(pos) { onOk(pos.coords); },
            function(err) {
                showToast(err && err.code === 1
                    ? 'Geolocalisation refusee. Autoriser l\'acces a la position.'
                    : 'Position introuvable. Se placer a ciel degage et reessayer.', 6000);
            },
            { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }
        );
    }
    // A — Publie un point "Position de ..." sur la carte collaborative.
    // Passe par le wrapper fetch -> hors-ligne : mis en file + marqueur orange.
    function _shareMyPositionOnMap() {
        var SU = window.SUPABASE_URL, SK = window.SUPABASE_KEY;
        if (!SU || !SK) {
            showToast('Partage indisponible (configuration Supabase absente).', 5000);
            return;
        }
        _getPositionOnce(function(c) {
            var auteur = (window.CONTRIBUTEUR || window.contributeurActuel || 'Position partagee');
            var d = new Date();
            var hh = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            var body = {
                projet_id: (window.DRAWING_PROJET_ID || window.PROJET_ID || null),
                feature_type: 'point',
                geometry: { type: 'Point', coordinates: [c.longitude, c.latitude] },
                name: 'Position de ' + auteur + ' — ' + hh,
                description: 'Position partagee · precision ~' + Math.round(c.accuracy || 0)
                    + ' m · ' + d.toLocaleDateString('fr-FR') + ' ' + hh,
                category: 'Position',
                color: '#c0392b',
                auteur: auteur
            };
            try {
                if (typeof window._mapHash === 'function') body.created_on_carte_hash = window._mapHash();
            } catch(_e) {}
            showToast('Envoi de la position...', 3000);
            fetch(SU + '/rest/v1/custom_features', {
                method: 'POST',
                headers: {
                    'apikey': SK, 'Authorization': 'Bearer ' + SK,
                    'Content-Type': 'application/json', 'Prefer': 'return=minimal'
                },
                body: JSON.stringify(body)
            }).then(function(r) {
                if (r && (r.ok || r.status === 201 || r.status === 204)) {
                    showToast('Position publiee sur la carte.', 5000);
                    if (typeof window.loadCustomFeatures === 'function') {
                        setTimeout(function() { window.loadCustomFeatures(); }, 600);
                    }
                } else if (r && r.status === 202) {
                    showToast('Hors-ligne : position mise en file, publiee au retour reseau.', 6000);
                } else {
                    showToast('Echec de la publication (HTTP ' + (r ? r.status : '?') + ').', 6000);
                }
            }).catch(function(e) {
                showToast('Echec : ' + (e && e.message ? e.message : 'erreur reseau'), 6000);
            });
        });
    }
    // B — Partage externe via navigator.share (lien carte universel maps).
    function _shareMyPositionLink() {
        _getPositionOnce(function(c) {
            var lat = c.latitude.toFixed(6), lon = c.longitude.toFixed(6);
            var mapsUrl = 'https://www.google.com/maps?q=' + lat + ',' + lon;
            var carteUrl = location.href.split('#')[0].split('?')[0] + '#' + lat + ',' + lon;
            var txt = 'Ma position : ' + lat + ', ' + lon
                + ' (precision ~' + Math.round(c.accuracy || 0) + ' m)'
                + '\nCarte : ' + carteUrl;
            // navigator.share exige un geste utilisateur RECENT : impossible
            // de l'appeler directement apres le fix GPS asynchrone (activation
            // expiree -> rejet silencieux). On affiche un panneau ; le tap sur
            // "Partager" devient un geste valide.
            var ex = document.getElementById('pwaPosShareModal');
            if (ex) ex.remove();
            var m = document.createElement('div');
            m.id = 'pwaPosShareModal';
            m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100070;' +
                'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
            var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
            (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);
            m.innerHTML =
                '<div style="background:#fff;border-radius:12px;max-width:420px;width:100%;padding:20px 22px;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
                '<h2 style="margin:0;font-size:16px;color:#5a3a1a;">Ma position</h2>' +
                '<button id="pwaPSClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:#8b7355;">&times;</button>' +
                '</div>' +
                '<div style="font-size:12px;color:#5a3a1a;background:#faf7f2;border:1px solid #f0ebe3;border-radius:6px;padding:8px 10px;margin-bottom:12px;word-break:break-all;line-height:1.5;">'
                + lat + ', ' + lon + ' (~' + Math.round(c.accuracy || 0) + ' m)<br>'
                + '<a href="' + mapsUrl + '" target="_blank" rel="noopener" style="color:#1a73e8;">Ouvrir dans Maps</a></div>' +
                '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
                (navigator.share ? '<button id="pwaPSshare" style="flex:1;background:#8b4513;color:#fff;border:none;border-radius:8px;padding:10px;font:600 13px Segoe UI;cursor:pointer;">Partager</button>' : '') +
                '<button id="pwaPScopy" style="flex:1;background:#f0ebe3;color:#5a3a1a;border:none;border-radius:8px;padding:10px;font:600 13px Segoe UI;cursor:pointer;">Copier</button>' +
                '</div></div>';
            function close() { m.remove(); }
            m.querySelector('#pwaPSClose').onclick = close;
            m.onclick = function(e) { if (e.target === m) close(); };
            var sh = m.querySelector('#pwaPSshare');
            if (sh) sh.onclick = function() {
                navigator.share({ title: 'Ma position', text: txt, url: mapsUrl })
                    .then(close)
                    .catch(function(err) {
                        if (err && err.name === 'AbortError') return;  // annule par l'utilisateur
                        showToast('Partage indisponible : utiliser Copier.', 5000);
                    });
            };
            m.querySelector('#pwaPScopy').onclick = function() {
                var full = txt + '\n' + mapsUrl;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(full).then(function() {
                        showToast('Position copiee.', 4000); close();
                    }).catch(function() { prompt('Copier la position :', full); });
                } else {
                    prompt('Copier la position :', full);
                }
            };
        });
    }
    window._pwaSharePos = _shareMyPositionOnMap;

    // ============================================================
    //  C — Partage de position en DIRECT (polling, opt-in, TTL)
    //  Necessite la table Supabase live_positions (sql/live_positions.sql).
    //  Emission tant que l'app est au 1er plan ; sinon les autres voient
    //  la derniere position (limite web, comme l'enregistrement parcours).
    // ============================================================
    var _liveOn = false, _liveWatch = null, _liveLastSent = 0;
    var _livePoll = null, _liveLayer = null, _liveMarkers = {};
    var _liveTableMissing = false;
    var LIVE_TTL_MS = 180000;     // position consideree perimee apres 3 min
    var LIVE_SEND_MS = 15000;     // upsert au max toutes les 15 s
    var LIVE_POLL_MS = 15000;     // lecture des autres toutes les 15 s

    function _liveId() {
        var v;
        try { v = localStorage.getItem('pwaLiveId'); } catch(_e) {}
        if (!v) {
            v = 'lp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
            try { localStorage.setItem('pwaLiveId', v); } catch(_e) {}
        }
        return v;
    }
    function _liveName() {
        try { return localStorage.getItem('pwaLiveName') || ''; } catch(_e) { return ''; }
    }
    function _liveScope() {
        try { if (typeof window._mapHash === 'function') return String(window._mapHash()); } catch(_e) {}
        return (location.pathname.split('/').pop() || 'carte');
    }
    function _liveCreds() {
        return { u: window.SUPABASE_URL, k: window.SUPABASE_KEY };
    }

    function _liveUpsert(c) {
        var cr = _liveCreds();
        if (!cr.u || !cr.k || _liveTableMissing) return;
        var now = Date.now();
        var body = [{
            id: _liveId(),
            auteur: _liveName() || 'Anonyme',
            lat: +c.latitude.toFixed(6),
            lon: +c.longitude.toFixed(6),
            accuracy: Math.round(c.accuracy || 0),
            carte_hash: _liveScope(),
            updated_at: new Date(now).toISOString(),
            expires_at: new Date(now + LIVE_TTL_MS).toISOString()
        }];
        // _origFetch : ne PAS passer par la file offline (positions perimees
        // inutiles). on_conflict=id + merge-duplicates = upsert.
        _origFetch(cr.u + '/rest/v1/live_positions?on_conflict=id', {
            method: 'POST',
            headers: {
                'apikey': cr.k, 'Authorization': 'Bearer ' + cr.k,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates,return=minimal'
            },
            body: JSON.stringify(body)
        }).then(function(r) {
            if (r && (r.status === 404 || r.status === 400)) {
                r.text().then(function(t) {
                    if (/live_positions/.test(t) && /does not exist|relation/.test(t)) {
                        _liveTableMissing = true;
                        showToast('Partage live : table absente. Executer sql/live_positions.sql dans Supabase.', 8000);
                        _liveStop(true);
                    }
                }).catch(function(){});
            }
        }).catch(function(){});
    }

    function _liveStart() {
        if (_liveOn) return;
        if (!navigator.geolocation) { showToast('Geolocalisation indisponible.', 5000); return; }
        var nm = _liveName();
        if (!nm) {
            nm = (window.CONTRIBUTEUR || window.contributeurActuel || '').trim();
            nm = prompt('Nom affiche aux autres pour le partage en direct :', nm || '');
            if (nm == null) return;          // annule
            nm = (nm || 'Anonyme').trim().slice(0, 40);
            try { localStorage.setItem('pwaLiveName', nm); } catch(_e) {}
        }
        if (!confirm('Partager ta position EN DIRECT avec les utilisateurs de cette carte ?\n\n'
            + '- Visible tant que l\'app reste ouverte (arriere-plan/verrouille = position figee)\n'
            + '- Expire automatiquement apres 3 min sans maj\n'
            + '- Arret a tout moment via le bouton Position')) return;
        _liveOn = true;
        _liveLastSent = 0;
        _liveWatch = navigator.geolocation.watchPosition(function(pos) {
            if (!_liveOn) return;
            var now = Date.now();
            if (now - _liveLastSent < LIVE_SEND_MS) return;  // throttle
            _liveLastSent = now;
            _liveUpsert(pos.coords);
        }, function(){}, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
        _liveUpdateIndicator();
        showToast('Partage en direct active.', 4000);
    }
    function _liveStop(silent) {
        if (!_liveOn && !_liveWatch) { _liveUpdateIndicator(); return; }
        _liveOn = false;
        if (_liveWatch != null) {
            try { navigator.geolocation.clearWatch(_liveWatch); } catch(_e) {}
            _liveWatch = null;
        }
        var cr = _liveCreds();
        if (cr.u && cr.k && !_liveTableMissing) {
            try {
                _origFetch(cr.u + '/rest/v1/live_positions?id=eq.' + encodeURIComponent(_liveId()), {
                    method: 'DELETE',
                    headers: { 'apikey': cr.k, 'Authorization': 'Bearer ' + cr.k },
                    keepalive: true
                }).catch(function(){});
            } catch(_e) {}
        }
        _liveUpdateIndicator();
        if (!silent) showToast('Partage en direct arrete.', 4000);
    }
    // Best-effort : retirer ma ligne a la fermeture (sinon le TTL s'en charge)
    window.addEventListener('pagehide', function() { if (_liveOn) _liveStop(true); });

    function _liveEnsureLayer() {
        var map = findLeafletMap();
        if (!map || typeof L === 'undefined') return null;
        if (!_liveLayer) _liveLayer = L.layerGroup().addTo(map);
        return _liveLayer;
    }
    function _liveRender(rows) {
        var layer = _liveEnsureLayer();
        if (!layer) return;
        var mine = _liveId();
        var present = {};
        (rows || []).forEach(function(p) {
            if (!p || p.id === mine || p.lat == null || p.lon == null) return;
            present[p.id] = true;
            var ll = [p.lat, p.lon];
            var ageS = Math.max(0, Math.round((Date.now() - new Date(p.updated_at).getTime()) / 1000));
            var label = (p.auteur || 'Anonyme') + ' · il y a ' + ageS + ' s';
            var mk = _liveMarkers[p.id];
            if (!mk) {
                mk = L.marker(ll, {
                    icon: L.divIcon({
                        className: 'pwa-live-marker',
                        html: '<div style="width:18px;height:18px;border-radius:50%;background:#1a73e8;'
                            + 'border:3px solid #fff;box-shadow:0 0 0 2px #1a73e8,0 2px 6px rgba(0,0,0,0.4);"></div>',
                        iconSize: [18, 18], iconAnchor: [9, 9]
                    }), zIndexOffset: 8000
                }).addTo(layer);
                _liveMarkers[p.id] = mk;
            } else {
                mk.setLatLng(ll);
            }
            mk.bindTooltip(label, { direction: 'top', offset: [0, -10] });
        });
        Object.keys(_liveMarkers).forEach(function(id) {
            if (!present[id]) {
                try { layer.removeLayer(_liveMarkers[id]); } catch(_e) {}
                delete _liveMarkers[id];
            }
        });
    }
    function _livePollOnce() {
        var cr = _liveCreds();
        if (!cr.u || !cr.k || _liveTableMissing) return;
        var q = cr.u + '/rest/v1/live_positions?select=*'
            + '&carte_hash=eq.' + encodeURIComponent(_liveScope())
            + '&expires_at=gt.' + encodeURIComponent(new Date().toISOString());
        _origFetch(q, { headers: { 'apikey': cr.k, 'Authorization': 'Bearer ' + cr.k } })
            .then(function(r) {
                if (!r) return;
                if (r.status === 404 || r.status === 400) {
                    return r.text().then(function(t) {
                        if (/live_positions/.test(t) && /does not exist|relation/.test(t)) {
                            _liveTableMissing = true;
                            if (_livePoll) { clearInterval(_livePoll); _livePoll = null; }
                        }
                    });
                }
                if (r.ok) return r.json().then(_liveRender);
            }).catch(function(){});
    }
    function _liveStartPoll(attempt) {
        attempt = attempt || 0;
        if (_livePoll) return;
        if (!findLeafletMap() && attempt < 20) {
            setTimeout(function() { _liveStartPoll(attempt + 1); }, 700);
            return;
        }
        _livePollOnce();
        _livePoll = setInterval(_livePollOnce, LIVE_POLL_MS);
    }
    function _liveUpdateIndicator() {
        var pb = document.getElementById('pwaPosBtn');
        if (!pb) return;
        var lbl = document.getElementById('pwaPosLbl');
        var dot = document.getElementById('pwaPosDot');
        // Live actif : libelle "Position (live)" + bouton bleu (comme avant).
        if (lbl) lbl.textContent = _liveOn ? 'Position (live)' : 'Position';
        if (dot) { dot.style.display = 'none'; dot.style.animation = ''; }
        pb.style.setProperty('background',
            _liveOn ? 'rgba(26,115,232,0.95)' : 'rgba(255,255,255,0.95)', 'important');
        pb.style.setProperty('color', _liveOn ? '#fff' : '#5a3a1a', 'important');
    }
    function _liveToggle() {
        if (_liveOn) _liveStop(); else _liveStart();
    }
    window.addEventListener('load', function() {
        setTimeout(function() { _liveStartPoll(0); }, 1800);
    });

    // ===== GPS warm-up =====
    // Le premier appel a navigator.geolocation peut prendre 5-15s sur smartphone
    // car le module GPS doit s'allumer et acquerir un fix satellite. Si la
    // permission est deja accordee, on declenche un fix silencieux au load
    // pour qu'il soit deja disponible quand l'utilisateur clique sur le bouton
    // de geolocalisation. Resultat : reponse quasi-instantanee au 1er click.
    if (navigator.geolocation && navigator.permissions) {
        navigator.permissions.query({ name: 'geolocation' })
            .then(function(result) {
                if (result.state === 'granted') {
                    // Permission deja accordee : warm-up silencieux apres 3s
                    // (laisse la carte se charger d'abord pour ne pas competir
                    // sur les ressources)
                    setTimeout(function() {
                        navigator.geolocation.getCurrentPosition(
                            function() { console.log('[GPS] Warm-up reussi'); },
                            function(e) { console.log('[GPS] Warm-up echec :', e.message); },
                            { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }
                        );
                    }, 3000);
                }
            })
            .catch(function() {});
    }


    // ===== Indicateur d'acquisition GPS (bouton "localise") =====
    // Le LocateControl Folium a timeout=8000 : trop court pour un cold-start
    // GPS hors-ligne (30s-2min). On affiche un indicateur clair au clic, et si
    // le plugin echoue par timeout on relance un fix long nous-memes puis on
    // re-declenche le bouton (position alors chaude -> fix quasi-instantane).
    var _geoIndEl = null, _geoHardTimer = null, _geoRetryDone = false, _geoWatchId = null;

    function _geoShowIndicator(text) {
        if (!_geoIndEl) {
            _geoIndEl = document.createElement('div');
            _geoIndEl.id = 'pwaGeoIndicator';
            _geoIndEl.style.cssText =
                'position:fixed !important;top:14px !important;left:50% !important;' +
                'transform:translateX(-50%);z-index:100070 !important;' +
                'display:flex;align-items:center;gap:10px;padding:9px 16px;' +
                'background:rgba(40,40,40,0.95);color:#fff;border-radius:22px;' +
                'box-shadow:0 4px 14px rgba(0,0,0,0.28);font:600 12px Segoe UI,sans-serif;' +
                'max-width:90vw;';
            (document.body || document.documentElement).appendChild(_geoIndEl);
        }
        _geoIndEl.innerHTML =
            '<span style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.35);' +
            'border-top-color:#27ae60;border-radius:50%;display:inline-block;' +
            'animation:pwaGeoSpin 0.8s linear infinite;flex:none;"></span>' +
            '<span style="flex:1;">' + text + '</span>' +
            '<button id="pwaGeoCancel" style="background:none;border:none;color:#bbb;' +
            'font-size:18px;cursor:pointer;padding:0 2px;line-height:1;flex:none;">&times;</button>';
        if (!document.getElementById('pwaGeoSpinStyle')) {
            var st = document.createElement('style');
            st.id = 'pwaGeoSpinStyle';
            st.textContent = '@keyframes pwaGeoSpin{to{transform:rotate(360deg)}}';
            document.head.appendChild(st);
        }
        document.getElementById('pwaGeoCancel').onclick = function() { _geoHideIndicator(); };
    }
    function _geoHideIndicator() {
        if (_geoHardTimer) { clearTimeout(_geoHardTimer); _geoHardTimer = null; }
        if (_geoWatchId != null && navigator.geolocation) {
            try { navigator.geolocation.clearWatch(_geoWatchId); } catch(_e) {}
            _geoWatchId = null;
        }
        if (_geoIndEl && _geoIndEl.parentNode) _geoIndEl.parentNode.removeChild(_geoIndEl);
        _geoIndEl = null;
    }
    function _geoFinalMessage(msg) {
        if (!_geoIndEl) _geoShowIndicator('');
        _geoIndEl.innerHTML =
            '<span style="flex:1;">' + msg + '</span>' +
            '<button id="pwaGeoCancel" style="background:none;border:none;color:#bbb;' +
            'font-size:18px;cursor:pointer;padding:0 2px;line-height:1;flex:none;">&times;</button>';
        document.getElementById('pwaGeoCancel').onclick = function() { _geoHideIndicator(); };
        setTimeout(function() {
            // Auto-hide seulement si c'est toujours ce message d'echec
            if (_geoIndEl && /introuvable|echec|refus/i.test(_geoIndEl.textContent)) _geoHideIndicator();
        }, 9000);
    }

    function _geoStartAcquisition() {
        _geoRetryDone = false;
        var offline = (typeof isAppOffline === 'function') ? isAppOffline() : !navigator.onLine;
        _geoShowIndicator(offline
            ? 'Acquisition GPS… (hors-ligne : peut prendre jusqu\'a 1-2 min, ciel degage)'
            : 'Acquisition GPS en cours…');
        if (_geoHardTimer) clearTimeout(_geoHardTimer);
        // Cap dur : si rien apres 2min30, on abandonne avec un message
        _geoHardTimer = setTimeout(function() {
            _geoFinalMessage('Position GPS introuvable. Va a ciel degage et reessaie.');
        }, 150000);
    }

    // Repli : le LocateControl a echoue (timeout 8s trop court). On tente un
    // fix long nous-memes puis on re-clique le bouton (position chaude).
    function _geoLongRetry(locateAnchor) {
        if (_geoRetryDone || !navigator.geolocation) return;
        _geoRetryDone = true;
        var offline = (typeof isAppOffline === 'function') ? isAppOffline() : !navigator.onLine;
        _geoShowIndicator(offline
            ? 'GPS lent (demarrage a froid hors-ligne)… recherche en cours, reste a ciel degage'
            : 'GPS lent… recherche en cours');
        navigator.geolocation.getCurrentPosition(
            function() {
                // Position desormais chaude (cachee par l'OS). Re-declencher le
                // bouton : le LocateControl la recupere via maximumAge -> instant.
                if (locateAnchor) {
                    try { locateAnchor.click(); } catch(_e) {}
                }
                // Filet : si le plugin ne reagit pas vite, on hide quand meme apres 6s
                setTimeout(function() {
                    if (_geoIndEl) _geoHideIndicator();
                }, 6000);
            },
            function(err) {
                _geoFinalMessage(err && err.code === 1
                    ? 'Geolocalisation refusee. Autorise-la dans les reglages.'
                    : 'Position GPS introuvable. Va a ciel degage et reessaie.');
            },
            { enableHighAccuracy: true, timeout: offline ? 120000 : 30000, maximumAge: 0 }
        );
    }

    function _hookLocateControl(attempt) {
        attempt = attempt || 0;
        var map = findLeafletMap();
        var ctl = document.querySelector('.leaflet-control-locate');
        if ((!map || !ctl) && attempt < 20) {
            setTimeout(function() { _hookLocateControl(attempt + 1); }, 600);
            return;
        }
        if (!map || !ctl) return;
        var anchor = ctl.querySelector('a') || ctl;

        // Clic utilisateur : si ca DEMARRE une acquisition (le plugin ajoute la
        // classe 'requesting'/'active' juste apres), afficher l'indicateur.
        anchor.addEventListener('click', function() {
            setTimeout(function() {
                var starting = ctl.classList.contains('requesting')
                    || ctl.classList.contains('active');
                if (starting) _geoStartAcquisition();
                else _geoHideIndicator();  // l'utilisateur a stoppe le suivi
            }, 60);
        });

        // Succes : le plugin a trouve la position
        map.on('locationfound', function() { _geoHideIndicator(); });

        // Echec : timeout 8s du plugin trop court -> repli fix long
        map.on('locationerror', function(e) {
            if (!_geoIndEl) return;  // pas d'acquisition en cours, ignorer
            if (!_geoRetryDone) {
                _geoLongRetry(anchor);
            } else {
                _geoFinalMessage(e && e.code === 1
                    ? 'Geolocalisation refusee. Autorise-la dans les reglages.'
                    : 'Position GPS introuvable. Va a ciel degage et reessaie.');
            }
        });
    }
    window.addEventListener('load', function() {
        setTimeout(function() { _hookLocateControl(0); }, 1200);
    });

    // ===== Badge derriere la fiche detail quand elle est ouverte =====
    // #modernDetailPanel (z-index 10002) : sur mobile = bottom-sheet, le badge
    // (z-index 100050) passait par-dessus. Quand la fiche est .open, on
    // descend le badge sous la fiche ; on le restaure a la fermeture.
    function _watchDetailPanelForBadge(attempt) {
        attempt = attempt || 0;
        var panel = document.getElementById('modernDetailPanel');
        if (!panel) {
            if (attempt < 15) setTimeout(function() { _watchDetailPanelForBadge(attempt + 1); }, 700);
            return;
        }
        function sync() {
            var badge = document.getElementById('pwaStatusBadge');
            var pb = document.getElementById('pwaPosBtn');
            var open = panel.classList.contains('open');
            var zi = open ? '9000' : '100050';
            if (badge) badge.style.setProperty('z-index', zi, 'important');
            if (pb) pb.style.setProperty('z-index', zi, 'important');
        }
        sync();
        new MutationObserver(sync).observe(panel, {
            attributes: true, attributeFilter: ['class']
        });
    }
    window.addEventListener('load', function() {
        setTimeout(function() { _watchDetailPanelForBadge(0); }, 1000);
    });

    // ===== Badge s'adapte au panneau (afficher/masquer) =====
    // Meme logique que le FAB geoloc (_setupGeolocFabPosition cote carte) :
    //  - mobile + sidebar ouverte (bottom-sheet) : remonter le badge au-dessus
    //  - desktop + sidebar ouverte (370px a gauche) : decaler le badge a droite
    //    de la sidebar (le badge est en bas-GAUCHE, donc masque sinon)
    //  - sinon : position par defaut (bas 10 / gauche 10)
    function _watchSidebarForBadge(attempt) {
        attempt = attempt || 0;
        var sidebar = document.getElementById('searchContainer');
        if (!sidebar) {
            if (attempt < 15) setTimeout(function() { _watchSidebarForBadge(attempt + 1); }, 700);
            return;
        }
        function adjust() {
            var badge = document.getElementById('pwaStatusBadge');
            if (!badge) return;
            var pb = document.getElementById('pwaPosBtn');
            var isMobile = window.innerWidth <= 768;
            var isOpen = !sidebar.classList.contains('collapsed');
            var bottom, left;
            if (isOpen && isMobile) {
                var h = sidebar.offsetHeight;
                var maxBottom = Math.floor(window.innerHeight * 0.55);
                bottom = Math.min(h + 8, maxBottom); left = 10;
            } else if (isOpen && !isMobile) {
                bottom = 10; left = sidebar.offsetWidth + 12;
            } else {
                bottom = 10; left = 10;
            }
            badge.style.setProperty('bottom', bottom + 'px', 'important');
            badge.style.setProperty('left', left + 'px', 'important');
            // Bouton Position : juste au-dessus du badge (~36 px plus haut)
            if (pb) {
                pb.style.setProperty('bottom', (bottom + 36) + 'px', 'important');
                pb.style.setProperty('left', left + 'px', 'important');
            }
        }
        adjust();
        window.addEventListener('resize', adjust);
        new MutationObserver(adjust).observe(sidebar, {
            attributes: true, attributeFilter: ['class']
        });
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(adjust).observe(sidebar);
        }
        setTimeout(adjust, 600);
        setTimeout(adjust, 1600);
    }
    window.addEventListener('load', function() {
        setTimeout(function() { _watchSidebarForBadge(0); }, 1000);
    });

    // ===== Bootstrap + auto-sync robuste =====
    // L'event 'online' ne tire que si la page est OUVERTE pendant la transition
    // offline -> online. Insuffisant car l'utilisateur ferme souvent l'app
    // entre la modif offline et le retour reseau. On ajoute donc :
    //   - replay au load si queue non vide
    //   - replay au focus (utilisateur revient sur l'onglet)
    //   - replay au visibilitychange (Android : passe en avant-plan)
    //   - polling toutes les 30s tant que queue non vide
    //   - register Background Sync (SW prend le relais meme app fermee)
    var _queuePollInterval = null;
    function ensureQueuePolling() {
        if (_queuePollInterval) return;
        _queuePollInterval = setInterval(function() {
            if (!navigator.onLine) return;
            dbAll().then(function(items) {
                if (items.length === 0) {
                    clearInterval(_queuePollInterval);
                    _queuePollInterval = null;
                } else {
                    replayQueue();
                }
            });
        }, 30000);
    }

    function autoReplay() {
        if (!navigator.onLine) return;
        dbAll().then(function(items) {
            if (items.length > 0) {
                replayQueue();
                ensureQueuePolling();
            }
        });
    }

    window.addEventListener('load', function() {
        setTimeout(function() {
            updateStatusBadge();
            // 0. Demander le stockage persistant (silencieux). Accorde sans
            //    prompt pour une PWA installee -> evite l'eviction des tuiles.
            _requestPersistentStorage(false);
            // 0. Mettre en cache la page courante (HTML) si en ligne, pour
            //    qu'elle soit lancable hors-ligne. Le 1er chargement n'est PAS
            //    intercepte par le SW -> sans ca : "Offline" au lancement.
            try {
                if (navigator.onLine && navigator.serviceWorker && navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({
                        type: 'CACHE_PAGE', url: location.href.split('#')[0]
                    });
                }
            } catch(_e) {}
            // 0. Patcher les TileLayers deja en place (maxNativeZoom etc.)
            _patchExistingTileLayers();
            // 0ter. maxNativeZoom adaptatif selon ce qui est reellement cache
            setTimeout(_applyAdaptiveNativeZoom, 400);
            // 0quater. re-armement par vue (net dans zones detaillees)
            setTimeout(function() { _setupNativeZoomReprobe(0); }, 700);
            // 0bis. Afficher la zone hors-ligne par defaut si une zone est storee
            //       (l'utilisateur peut la masquer via le menu si besoin)
            try {
                if (getStoredZone() && !_zoneHiddenByUser()) {
                    showPrecachedZoneOnMap(true);  // persistent=true : pas de fitBounds
                }
            } catch(_e) {}
            // 1. Restaurer les markers orange "en attente" depuis la queue IndexedDB
            //    (avant le replay : si on est online, le replay videra la queue et
            //    les markers seront remplaces par les vraies features ; si on est
            //    offline, ils resteront visibles jusqu'au retour reseau)
            restoreOfflineMarkersFromQueue();
            // 2. Tenter un sync si reseau dispo + queue non vide
            autoReplay();
            // Resync le flag mode test au SW (s'il a redemarre entre temps)
            if (isForcedOffline() && navigator.serviceWorker && navigator.serviceWorker.ready) {
                navigator.serviceWorker.ready.then(function(reg) {
                    if (reg.active) reg.active.postMessage({ type: 'SET_FORCE_OFFLINE', value: true });
                });
            }
        }, 800);
    });
    window.addEventListener('online', function() {
        updateStatusBadge();
        setTimeout(autoReplay, 500);
        _applyAdaptiveNativeZoom();  // en ligne : detail reseau complet
    });
    window.addEventListener('offline', function() {
        updateStatusBadge();
        _applyAdaptiveNativeZoom();  // hors-ligne : cap au zoom cache (upscale)
    });
    window.addEventListener('focus', autoReplay);
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') autoReplay();
    });

    // Ecouter les messages du SW (Background Sync notifie quand sync est faite)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', function(e) {
            var d = e.data || {};
            if (d.type === 'QUEUE_SYNCED') {
                console.log('[PWA Sync] BG terminee : ' + d.processed + ' traitee(s), ' +
                            d.dropped + ' droppee(s), ' + d.remaining + ' restante(s)');
                updateQueueBadge();
                if (d.processed > 0) {
                    showToast(d.processed + ' modification(s) synchronisee(s)' +
                              (d.dropped > 0 ? ' (' + d.dropped + ' rejetee(s))' : ''));
                    // Nettoyer les markers offline + recharger les vraies features
                    clearOfflineLayer();
                    if (typeof window.loadCustomFeatures === 'function') {
                        setTimeout(function() { window.loadCustomFeatures(); }, 300);
                    }
                }
            }
        });
    }

    // Expose API
    window._pwa = window._pwa || {};
    window._pwa.replayQueue = replayQueue;
    window._pwa.getQueue = dbAll;
    window._pwa.clearCache = clearCache;
    window._pwa.stats = getCacheStats;
    window._pwa.openMenu = openOfflineMenu;
    window._pwa.openQueue = openQueueDetailsModal;
    window._pwa.rename = openRenameShortcutModal;
    window._pwa.install = openInstallFlow;
    window._pwa.toast = showToast;
})();
