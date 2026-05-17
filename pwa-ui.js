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
    var DB_VERSION = 2;
    var STORE = 'queue';
    var BATCH_STORE = 'precacheBatches';  // 1 entree par pre-cache lance par l'utilisateur

    // ===== Patch Leaflet : zoom au-dela du max n'efface plus le calque =====
    // Par defaut, quand on zoome au-dela du maxZoom d'une couche, Leaflet la
    // fait disparaitre. On preferere garder les tuiles upscalees (floues mais
    // visibles) pour le reperage offline. On force donc maxNativeZoom = ancien
    // maxZoom (= dernier zoom ou les tuiles existent reellement) et on bump
    // maxZoom a 22 (limite Leaflet). Idem pour minNativeZoom / minZoom.
    function _patchTileLayerOptions(layer) {
        if (!layer || !layer.options) return;
        var o = layer.options;
        // maxNativeZoom haut : Leaflet demande les tuiles profondes ; si elles
        // ne sont pas cachees, le SW renvoie la tuile parente recadree
        // (_ancestorTile) -> pas de trou au ZOOM.
        if (o.maxNativeZoom == null) o.maxNativeZoom = (o.maxZoom != null ? o.maxZoom : 19);
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
                if (l instanceof L.TileLayer && l.options.maxNativeZoom !== ceil) {
                    // Pas de redraw : le move/zoom en cours va re-demander les
                    // tuiles avec cette nouvelle valeur. 'tileerror' rabaissera
                    // uniquement la ou le cache est moins profond.
                    l.options.maxNativeZoom = ceil;
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
                if (offline && maxCached) {
                    // Hors-ligne avec indice : cap au zoom cache -> upscale CSS
                    if (l.options.maxNativeZoom !== maxCached) {
                        l.options.maxNativeZoom = maxCached;
                        if (l._map) try { l.redraw(); } catch(_e) {}
                    }
                } else if (offline) {
                    // Hors-ligne SANS metadonnees : on ne force PAS un cap haut
                    // (ferait clignoter des trous). Le hook 'tileerror'
                    // (_attachTileErrorFallback) baissera tout seul au besoin.
                } else {
                    // En ligne : maxNativeZoom haut (le SW gere le > max serveur)
                    if (l.options.maxNativeZoom !== 21) {
                        l.options.maxNativeZoom = 21;
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

    // Refresh badge si on entre/sort du fullscreen (re-parenter au bon contexte)
    document.addEventListener('fullscreenchange', function() {
        var b = document.getElementById('pwaStatusBadge');
        if (b) { b.remove(); }
        setTimeout(updateStatusBadge, 100);
    });

    function updateStatusBadge() {
        var b = ensureBadge();
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
        // Style cohérent avec l'UI moderne (palette brun/olive + dark accents)
        var btnPrimary = 'background:#8b4513;color:#fff;border:none;padding:9px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI,sans-serif;text-align:left;width:100%;transition:background 0.15s;';
        var btnSecondary = 'background:#f0ebe3;color:#5a3a1a;border:1px solid #d8cdb8;padding:9px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI,sans-serif;text-align:left;width:100%;transition:background 0.15s;';
        var btnAccent = 'background:#5a3a1a;color:#fff;border:none;padding:9px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI,sans-serif;text-align:left;width:100%;transition:background 0.15s;';
        var btnDanger = 'background:#fff;color:#c0392b;border:1px solid #e8a8a0;padding:9px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI,sans-serif;text-align:left;width:100%;transition:background 0.15s;';
        var btnTest = 'background:' + (isForcedOffline() ? '#16a085' : '#fff') + ';color:' + (isForcedOffline() ? '#fff' : '#8b4513') + ';border:1px solid ' + (isForcedOffline() ? '#16a085' : '#d8cdb8') + ';padding:9px 12px;border-radius:6px;cursor:pointer;font:600 12px Segoe UI,sans-serif;text-align:left;width:100%;transition:background 0.15s;';
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
            '<button id="pwaMCheckCache" style="' + btnSecondary + '">Verifier cache de la zone visible</button>' +
            '<button id="pwaMClear" style="' + btnSecondary + '">Consulter / gerer le cache hors-ligne</button>' +
            '</div>' +

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
        document.getElementById('pwaMCheckCache').onclick = function() {
            var map = findLeafletMap();
            if (!map) { showToast('Carte non detectee'); return; }
            var bounds = map.getBounds();
            var zoom = map.getZoom();
            var layerUrls = collectTileLayerUrls(map);
            var n = Math.pow(2, zoom);
            var nb = bounds.getNorth(), sb = bounds.getSouth(), wb = bounds.getWest(), eb = bounds.getEast();
            var xmin = Math.floor((wb + 180) / 360 * n);
            var xmax = Math.floor((eb + 180) / 360 * n);
            var ymin = Math.floor((1 - Math.log(Math.tan(nb * Math.PI/180) + 1/Math.cos(nb * Math.PI/180))/Math.PI)/2 * n);
            var ymax = Math.floor((1 - Math.log(Math.tan(sb * Math.PI/180) + 1/Math.cos(sb * Math.PI/180))/Math.PI)/2 * n);
            var expected = [];
            for (var x = Math.min(xmin,xmax); x <= Math.max(xmin,xmax); x++) {
                for (var y = Math.min(ymin,ymax); y <= Math.max(ymin,ymax); y++) {
                    layerUrls.forEach(function(tpl) {
                        if (tpl.indexOf('{s}') !== -1) {
                            ['a','b','c'].forEach(function(s) {
                                expected.push(tpl.replace('{z}',zoom).replace('{x}',x).replace('{y}',y).replace('{s}',s));
                            });
                        } else {
                            expected.push(tpl.replace('{z}',zoom).replace('{x}',x).replace('{y}',y));
                        }
                    });
                }
            }
            caches.open('tiles-topo-v1').then(function(cache) {
                Promise.all(expected.map(function(u) { return cache.match(u).then(function(r) { return !!r; }); }))
                    .then(function(results) {
                        var hits = results.filter(function(x) { return x; }).length;
                        alert('Zone visible (zoom ' + zoom + ') : ' + hits + ' / ' + expected.length + ' tuiles dans le cache. ' +
                              'Couches actives : ' + layerUrls.length + '.\n\n' +
                              (hits === 0 ? 'Aucune tuile cachee. Pre-charge cette zone d\'abord.' :
                               hits < expected.length ? 'Certaines tuiles manquent. Re-pre-charger cette zone peut aider.' :
                               'Toutes les tuiles sont cachees.'));
                    });
            }).catch(function(e) {
                alert('Erreur lecture cache : ' + e.message);
            });
            m.remove();
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
            '<div style="font-size:11px;color:#666;margin-bottom:8px;">Coche une ou plusieurs communes de Corse. La zone pre-cachee couvrira la bounding box englobante.</div>' +
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
            '<div style="font-size:10px;color:#999;margin-top:4px;">Astuce : active une couche dans la carte avant d\'ouvrir ce modal pour qu\'elle apparaisse cochee par defaut.</div>' +
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
                if (fb.key === 'lidar-hd-shadow') return o.url.indexOf('LIDAR-HD_MNT') >= 0;
                if (fb.key === 'plan-ign-j1') return o.url.indexOf('BDUNI.J1') >= 0;
                if (fb.key === 'orthophotos-actuelles') return /ORTHOIMAGERY\.ORTHOPHOTOS&/i.test(o.url) || /ORTHOIMAGERY\.ORTHOPHOTOS$/i.test(o.url.split('&')[0]);
                if (fb.key === 'orthophotos-1950') return o.url.indexOf('1950-1965') >= 0;
                if (fb.key === 'orthophotos-1965') return o.url.indexOf('1965-1980') >= 0;
                if (fb.key === 'cadastre-ign') return o.url.indexOf('CADASTRALPARCELS') >= 0;
                if (fb.key === 'terrier') return o.url.indexOf('TERRIER_V2') >= 0;
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
        var layerUrls = collectTileLayerUrls(map);
        if (layerUrls.length === 0) {
            showToast('Aucune couche de tuiles active pour le pre-cache Corse.', 6000);
            return;
        }
        var bounds = L.latLngBounds(
            [CORSE_BOUNDS.south, CORSE_BOUNDS.west],
            [CORSE_BOUNDS.north, CORSE_BOUNDS.east]
        );
        var zmax = (kind === 'full') ? 14 : 10;
        // Plan IGN J+1 (tuiles legeres ~15 Ko) : pousse plus profond que les
        // couches lourdes sur le contexte COMPLET (rendu net niveau rue/chemin
        // sur toute la Corse). z15 ≈ +~190 Mo seulement pour cette couche.
        var _deepSpec = null;
        if (kind === 'full') {
            for (var _li = 0; _li < layerUrls.length; _li++) {
                if (/GEOGRAPHICALGRIDSYSTEMS\.PLANIGNV2/i.test(layerUrls[_li])) {
                    _deepSpec = { url: layerUrls[_li], zmax: 15 };
                    break;
                }
            }
        }
        // Estimation : light ~ nLayers*4 Mo ; full ~ nLayers*180 Mo
        // (+~190 Mo si Plan IGN pousse a z15 sur toute la Corse).
        var _nL = layerUrls.length || 1;
        var _estBytes = (kind === 'full' ? _nL * 180 : _nL * 4) * 1e6;
        if (_deepSpec) _estBytes += 190 * 1e6;
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
            '<p style="margin:0 0 14px;font-size:12px;color:#666;line-height:1.5;">Ce nom apparaitra sous l\'icone sur ton ecran d\'accueil apres installation. Max 12 caracteres pour le nom court (au-dela : tronque).</p>' +
            '<input type="text" id="pwaRInput" maxlength="60" value="' + escapeHtml(defaultName) + '" placeholder="ex. Brando, Cap Corse..." style="width:100%;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:14px;margin-bottom:6px;">' +
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
        var nLayers = map ? countActiveTileLayers(map) : 1;
        // Estimations indicatives (Corse entiere, dependent du nb de couches actives)
        var lightMo = Math.max(3, Math.round(nLayers * 3));
        var fullMo = Math.max(180, nLayers * 175);

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
            'Pour que la carte fonctionne sans reseau, telecharge les fonds de la Corse. ' +
            'Tu pourras toujours pre-cacher une zone precise plus tard (zoom detaille).</p>' +
            '<button id="pwaTilesLight" style="display:block;width:100%;text-align:left;background:#f0ebe3;color:#5a3a1a;border:1px solid #d8cdb8;padding:11px 14px;border-radius:8px;cursor:pointer;font:600 13px Segoe UI,sans-serif;margin-bottom:8px;">' +
            'Leger — contexte Corse <span style="color:#8b7355;">(zooms 8-10, ~' + lightMo + ' Mo)</span><br>' +
            '<span style="font-weight:400;font-size:11px;color:#888;">Voir l\'ile entiere + grands axes. Rapide.</span></button>' +
            '<button id="pwaTilesFull" style="display:block;width:100%;text-align:left;background:#8b4513;color:#fff;border:none;padding:11px 14px;border-radius:8px;cursor:pointer;font:600 13px Segoe UI,sans-serif;margin-bottom:8px;">' +
            'Complet — toute la Corse <span style="opacity:.85;">(zooms 8-14, ~' + fullMo + ' Mo)</span><br>' +
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
                    return '<label style="display:flex;align-items:center;gap:10px;padding:8px 6px;border-bottom:1px solid #f4efe7;cursor:pointer;">' +
                        '<input type="checkbox" class="pwaCMcb" data-id="' + b.id + '">' +
                        '<span style="flex:1;">' +
                        '<strong>' + escapeHtml(b.label || b.id) + '</strong>' +
                        (b.kind === 'context' ? ' <span style="color:#16a085;font-size:10px;">(contexte, preserve au vidage)</span>' : '') +
                        '<br><span style="color:#999;font-size:11px;">' + (b.count || 0) + ' elements · ~' + mo + ' Mo · ' + dt + '</span>' +
                        '</span></label>';
                }).join('');
                listEl.querySelectorAll('input.pwaCMcb').forEach(function(cb) {
                    cb.onchange = function() {
                        delBtn.disabled = listEl.querySelectorAll('input.pwaCMcb:checked').length === 0;
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
            if (!badge) return;
            if (panel.classList.contains('open')) {
                // Derriere la fiche detail (z-index 10002)
                badge.style.setProperty('z-index', '9000', 'important');
            } else {
                badge.style.setProperty('z-index', '100050', 'important');
            }
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
            var isMobile = window.innerWidth <= 768;
            var isOpen = !sidebar.classList.contains('collapsed');
            if (isOpen && isMobile) {
                var h = sidebar.offsetHeight;
                var maxBottom = Math.floor(window.innerHeight * 0.55);
                badge.style.setProperty('bottom', Math.min(h + 8, maxBottom) + 'px', 'important');
                badge.style.setProperty('left', '10px', 'important');
            } else if (isOpen && !isMobile) {
                badge.style.setProperty('left', (sidebar.offsetWidth + 12) + 'px', 'important');
                badge.style.setProperty('bottom', '10px', 'important');
            } else {
                badge.style.setProperty('bottom', '10px', 'important');
                badge.style.setProperty('left', '10px', 'important');
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
