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
    var DB_VERSION = 1;
    var STORE = 'queue';

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

    // ===== Sync queue : wrapper fetch =====
    // Intercepte les fetch vers Supabase REST + Storage et, si offline ou si
    // l'appel echoue, met l'operation en queue pour replay au retour reseau.
    // Le body peut etre une string (JSON REST), un FormData (upload Storage)
    // ou un Blob -- on les serialise au mieux pour IndexedDB.
    var _origFetch = window.fetch.bind(window);

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
            return dbAdd({
                url: url,
                method: method,
                headers: init.headers || {},
                bodySer: bodySer,
                summary: summary,
                kind: isStorageMut ? 'storage' : 'rest',
                createdAt: Date.now(),
                attempts: 0
            }).then(function() {
                updateQueueBadge();
                ensureQueuePolling();
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
                    return new Response(JSON.stringify({ Key: pathMatch ? pathMatch[2] : '', queued: true, offline: true, publicUrl: fakeUrl }),
                        { status: 202, headers: { 'Content-Type': 'application/json' } });
                }
                return new Response(JSON.stringify({ queued: true, offline: true }),
                    { status: 202, headers: { 'Content-Type': 'application/json' } });
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
        b.innerHTML = dot + label + ' <span id="pwaQueueCount"></span>';
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
        m.innerHTML =
            '<div style="background:#fff;border-radius:10px;max-width:480px;width:100%;padding:20px 24px;box-shadow:0 4px 24px rgba(0,0,0,0.3);">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
            '<h2 style="margin:0;font-size:17px;color:#5a3a1a;">Mode hors-ligne</h2>' +
            '<button id="pwaMClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:#8b7355;">&times;</button>' +
            '</div>' +
            '<div id="pwaMStats" style="font-size:12px;color:#666;background:#faf7f2;padding:10px 12px;border-radius:6px;margin-bottom:14px;">Chargement des statistiques...</div>' +
            '<div style="display:flex;flex-direction:column;gap:8px;">' +
            '<button id="pwaMInstall" style="background:#27ae60;color:#fff;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-align:left;">Installer comme raccourci</button>' +
            '<button id="pwaMRename" style="background:#5a3a1a;color:#fff;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-align:left;">Renommer le raccourci</button>' +
            '<button id="pwaMPrecache" style="background:#8b4513;color:#fff;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-align:left;">Pre-charger la zone visible</button>' +
            '<button id="pwaMQueue" style="background:#5a3a1a;color:#fff;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-align:left;">Voir les modifs en attente</button>' +
            '<button id="pwaMReplay" style="background:#f5b041;color:#5a3a1a;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-align:left;">Forcer la synchro</button>' +
            '<button id="pwaMSimOffline" style="background:' + (isForcedOffline() ? '#27ae60' : '#9b59b6') + ';color:#fff;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-align:left;">' +
                (isForcedOffline() ? 'Repasser en ligne (sortie du test)' : 'Simuler hors ligne (mode test)') +
            '</button>' +
            '<button id="pwaMReload" style="background:#3498db;color:#fff;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-align:left;">Actualiser la page</button>' +
            '<button id="pwaMUpdate" style="background:#9b59b6;color:#fff;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-align:left;">Forcer mise a jour PWA</button>' +
            '<button id="pwaMClear" style="background:#e74c3c;color:#fff;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-align:left;">Vider le cache local</button>' +
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
                'Photos : ' + s.photos + '<br>' +
                'API : ' + s.api + '<br>' +
                'Cartes HTML : ' + s.html;
        });

        document.getElementById('pwaMInstall').onclick = function() { m.remove(); openInstallFlow(); };
        document.getElementById('pwaMRename').onclick = function() { m.remove(); openRenameShortcutModal(); };
        document.getElementById('pwaMPrecache').onclick = function() { m.remove(); openPrecacheModal(); };
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
            // 2. Vider tous les caches
            var cachePromise = 'caches' in window
                ? caches.keys().then(function(keys) {
                    return Promise.all(keys.map(function(k) { return caches.delete(k); }));
                  })
                : Promise.resolve();
            Promise.all([swPromise, cachePromise]).then(function() {
                showToast('Mise a jour : rechargement...');
                setTimeout(function() { location.reload(true); }, 800);
            });
        };
        document.getElementById('pwaMClear').onclick = function() {
            if (!confirm('Vider tout le cache offline ? Tu auras besoin de reseau au prochain demarrage.')) return;
            clearCache().then(function() { showToast('Cache vide.'); m.remove(); });
        };
    }

    // ===== Modal pre-cache zone =====
    // bounds par defaut = zone visible courante. L'utilisateur peut basculer
    // sur "Dessiner manuellement" pour tracer un rectangle libre sur la carte.
    function openPrecacheModal(customBounds) {
        var map = findLeafletMap();
        if (!map) { alert('Carte non detectee.'); return; }
        var bounds = customBounds || map.getBounds();
        var isCustom = !!customBounds;
        var curZoom = map.getZoom();
        var minZ = Math.max(curZoom - 1, 10);
        var maxZ = Math.min(curZoom + 2, 18);

        var m = document.createElement('div');
        m.id = 'pwaPrecacheModal';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10500;' +
            'display:flex;align-items:center;justify-content:center;padding:16px;font-family:Segoe UI,sans-serif;';
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        (fsEl && !fsEl.contains(document.body) ? fsEl : document.body).appendChild(m);

        var allLayers = listAvailableLayers(map);
        var allProjects = listAvailableProjects();

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
            '<input type="radio" name="pwaZoneSrc" value="draw"' + (isCustom ? ' checked' : '') + '> Dessiner manuellement un rectangle' +
            '</label>' +
            (isCustom ? '<div style="font-size:11px;color:#16a085;margin-top:4px;">Rectangle defini : ' +
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

            '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;color:#5a3a1a;margin-bottom:12px;cursor:pointer;">' +
            '<input type="checkbox" id="pwaIncludeCorse" style="margin-top:2px;">' +
            '<span>Inclure le contexte Corse complet aux zooms 8-10 (~80 tuiles, ~3 Mo). Utile pour dezoomer voir l\'ile entiere hors-ligne.</span>' +
            '</label>' +

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
            var includeCorse = document.getElementById('pwaIncludeCorse').checked;
            var corseTiles = includeCorse ? 80 * nLayers : 0;
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
                layerUrls: getCheckedLayers(), projectIds: getCheckedProjects()
            };
        }

        document.getElementById('pwaZmin').oninput = updateEstim;
        document.getElementById('pwaZmax').oninput = updateEstim;
        document.getElementById('pwaIncludeCorse').onchange = updateEstim;
        m.querySelectorAll('input.pwaLayerCb').forEach(function(cb) { cb.onchange = updateEstim; });
        m.querySelectorAll('input.pwaProjectCb').forEach(function(cb) { cb.onchange = updateEstim; });
        document.getElementById('pwaPCancel').onclick = function() { m.remove(); };
        document.getElementById('pwaPCancel2').onclick = function() { m.remove(); };
        m.onclick = function(e) { if (e.target === m) m.remove(); };

        // Si user choisit "Dessiner", fermer modal et activer outil Leaflet.draw
        m.querySelectorAll('input[name="pwaZoneSrc"]').forEach(function(r) {
            r.onchange = function() {
                if (r.value === 'draw' && r.checked) {
                    m.remove();
                    activateRectangleDraw(map);
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
            startPrecache(map, bounds, c.zmin, c.zmax, c.includeCorse, c.layerUrls, c.projectIds);
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
                showInfoBanner('Tap 2 pour le COIN OPPOSE du rectangle');
            } else {
                // Deuxieme clic : valider
                var b = L.latLngBounds(firstCorner, e.latlng);
                // Si trop petit, redemander
                var nePt = map.latLngToContainerPoint(b.getNorthEast());
                var swPt = map.latLngToContainerPoint(b.getSouthWest());
                if (Math.abs(nePt.x - swPt.x) < 15 || Math.abs(nePt.y - swPt.y) < 15) {
                    showInfoBanner('Rectangle trop petit, retape le coin oppose plus loin');
                    return;
                }
                // Tracer le rectangle final visible 1.2s pour feedback
                rectLayer = L.rectangle(b, {
                    color: '#8b4513', weight: 3, fillOpacity: 0.18, dashArray: '4,4'
                }).addTo(map);
                cleanup(true);
                openPrecacheModal(b);
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
        // (au cas ou un layer ne serait dans aucun control)
        for (var k2 in window) {
            try {
                var v = window[k2];
                if (v && v instanceof L.TileLayer && k2.indexOf('tile_layer') === 0) {
                    tryAdd(v, null, map.hasLayer(v));
                }
            } catch(e) {}
        }
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

    async function startPrecache(map, bounds, zmin, zmax, includeCorse, customLayerUrls, projectIds) {
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

        function addTilesForBounds(z, nb, sb, wb, eb) {
            var n = Math.pow(2, z);
            var xmin = Math.floor((wb + 180) / 360 * n);
            var xmax = Math.floor((eb + 180) / 360 * n);
            var ymin = Math.floor((1 - Math.log(Math.tan(nb * Math.PI / 180) + 1 / Math.cos(nb * Math.PI / 180)) / Math.PI) / 2 * n);
            var ymax = Math.floor((1 - Math.log(Math.tan(sb * Math.PI / 180) + 1 / Math.cos(sb * Math.PI / 180)) / Math.PI) / 2 * n);
            for (var x = Math.min(xmin, xmax); x <= Math.max(xmin, xmax); x++) {
                for (var y = Math.min(ymin, ymax); y <= Math.max(ymin, ymax); y++) {
                    layerUrls.forEach(function(tpl) {
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

        // 2. Contexte Corse optionnel (zooms 8-10)
        if (includeCorse) {
            for (var cz = 8; cz <= 10; cz++) {
                if (cz >= zmin && cz <= zmax) continue;
                addTilesForBounds(cz, CORSE_BOUNDS.north, CORSE_BOUNDS.south, CORSE_BOUNDS.west, CORSE_BOUNDS.east);
            }
        }

        // 3. Pre-cache des projets : fetch Supabase REST pour les data + photos
        var projectPhotoUrls = [];
        if (projectIds && projectIds.length > 0) {
            showToast('Telechargement data des projets...', 3000);
            for (var pi = 0; pi < projectIds.length; pi++) {
                var pid = projectIds[pi];
                try {
                    var supaBase = (typeof window.SUPABASE_URL !== 'undefined' && window.SUPABASE_URL) || '';
                    var supaKey = (typeof window.SUPABASE_KEY !== 'undefined' && window.SUPABASE_KEY) || '';
                    if (!supaBase || !supaKey) continue;
                    var url = supaBase + '/rest/v1/custom_features?projet_id=eq.' + pid + '&select=*';
                    var resp = await fetch(url, {
                        headers: { apikey: supaKey, Authorization: 'Bearer ' + supaKey }
                    });
                    if (resp.ok) {
                        // Le SW cache automatiquement via network-first (api cache)
                        var data = await resp.json();
                        if (Array.isArray(data)) {
                            data.forEach(function(f) {
                                if (f.photo_url) projectPhotoUrls.push(f.photo_url);
                                if (f.photo_url2) projectPhotoUrls.push(f.photo_url2);
                            });
                            console.log('[Pre-cache] Projet ' + pid + ' : ' + data.length + ' features chargees');
                        }
                    }
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
            if (modal && d.progress !== undefined) {
                var pct = Math.round((d.progress / d.total) * 100);
                modal.querySelector('#pwaPBar').style.width = pct + '%';
                modal.querySelector('#pwaPLabel').textContent = d.progress + ' / ' + d.total + ' (' + pct + '%)' + (d.errors ? ' — ' + d.errors + ' erreurs' : '');
                if (d.done) {
                    setTimeout(function() {
                        if (modal && modal.parentNode) modal.remove();
                        showToast('Pre-cache termine : ' + d.progress + ' elements' + (d.errors ? ' (' + d.errors + ' erreurs)' : ''));
                    }, 500);
                }
            }
        };
        navigator.serviceWorker.controller.postMessage({ type: 'PRECACHE_URLS', urls: allUrls }, [ch.port2]);
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
            if (onSave) onSave(v);
            else {
                // Proposer de recharger pour appliquer
                if (confirm('Nom sauvegarde. Recharger la carte maintenant pour mettre a jour le manifest ?')) {
                    location.reload();
                } else {
                    showToast('Recharge la page pour appliquer le nouveau nom au raccourci.');
                }
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
        // On force d'abord le rename, puis on declenche l'install
        openRenameShortcutModal(function(newName) {
            // Si nouveau nom sauve : reload pour mettre a jour le manifest AVANT install
            if (newName) {
                showToast('Rechargement pour appliquer le nom...');
                setTimeout(function() {
                    sessionStorage.setItem('pwaInstallAfterReload', '1');
                    location.reload();
                }, 600);
                return;
            }
            // Pas de changement de nom -> declencher l'install direct
            triggerInstall();
        });
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
    window.addEventListener('load', function() {
        try {
            if (sessionStorage.getItem('pwaInstallAfterReload') === '1') {
                sessionStorage.removeItem('pwaInstallAfterReload');
                // Attendre un peu que beforeinstallprompt arrive
                setTimeout(function() { triggerInstall(); }, 1500);
            }
        } catch(_e) {}
    });


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

    function addOfflineFeatureToMap(body) {
        var map = findLeafletMap();
        var layer = _ensureOfflineLayer();
        if (!map || !layer) return;
        var g = body.geometry;
        var name = body.name || body.nom || 'Point en attente';
        var labelHtml = '<span style="background:#f39c12;color:#fff;padding:2px 6px;border-radius:8px;font-size:10px;font-weight:600;">En attente</span> <strong>' + escapeHtml(name) + '</strong>';

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

    function clearCache() {
        return new Promise(function(resolve) {
            if (!navigator.serviceWorker.controller) { resolve(false); return; }
            var ch = new MessageChannel();
            ch.port1.onmessage = function(e) { resolve(e.data && e.data.cleared); };
            navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' }, [ch.port2]);
        });
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
            autoReplay();
        }, 800);
    });
    window.addEventListener('online', function() {
        updateStatusBadge();
        setTimeout(autoReplay, 500);
    });
    window.addEventListener('offline', updateStatusBadge);
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
