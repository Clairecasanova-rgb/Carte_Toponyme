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
    // Intercepte les fetch POST/PATCH/DELETE vers Supabase et, si offline ou
    // si l'appel echoue, met l'operation en queue pour replay au retour reseau.
    var _origFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
        init = init || {};
        var url = typeof input === 'string' ? input : (input.url || '');
        var method = (init.method || 'GET').toUpperCase();
        var isSupabaseMutation = /supabase\.co\/rest\/v1\//.test(url) &&
                                 (method === 'POST' || method === 'PATCH' || method === 'DELETE');
        if (!isSupabaseMutation) return _origFetch(input, init);

        // Si online, tenter le reseau normalement. Sinon, queue direct.
        var attempt = _origFetch(input, init);
        return attempt.catch(function(err) {
            // Erreur reseau -> queue
            console.warn('[PWA Sync] Echec reseau, mise en queue :', method, url);
            // Snapshot d'identification (nom du point pour affichage modal)
            var summary = '';
            try {
                if (init.body) {
                    var parsed = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
                    summary = parsed.name || parsed.nom || '';
                }
            } catch(e) {}
            return dbAdd({
                url: url,
                method: method,
                headers: init.headers || {},
                body: init.body || null,
                summary: summary,
                createdAt: Date.now(),
                attempts: 0
            }).then(function() {
                updateQueueBadge();
                // Enregistrer un Background Sync (Chrome/Edge/Samsung)
                // Permet le replay meme app fermee des le retour reseau.
                if ('serviceWorker' in navigator && 'SyncManager' in window) {
                    navigator.serviceWorker.ready.then(function(reg) {
                        return reg.sync.register('sync-queue');
                    }).then(function() {
                        console.log('[PWA Sync] Background Sync enregistre');
                    }).catch(function(e) {
                        console.warn('[PWA Sync] Background Sync non dispo :', e.message);
                    });
                }
                // Faux Response OK pour ne pas casser le flux client
                return new Response(JSON.stringify({ queued: true, offline: true }),
                    { status: 202, headers: { 'Content-Type': 'application/json' } });
            });
        });
    };

    // ===== Replay queue au retour online =====
    var _replaying = false;
    async function replayQueue() {
        if (_replaying || !navigator.onLine) return;
        _replaying = true;
        try {
            var items = await dbAll();
            console.log('[PWA Sync] Replay : ' + items.length + ' operation(s)');
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                try {
                    var resp = await _origFetch(it.url, {
                        method: it.method,
                        headers: it.headers,
                        body: it.body
                    });
                    if (resp.ok || resp.status === 201) {
                        await dbDel(it.id);
                        console.log('[PWA Sync] OK :', it.method, it.url);
                    } else if (resp.status >= 500 || resp.status === 429) {
                        // Erreur serveur : on garde en queue
                        console.warn('[PWA Sync] Server error ' + resp.status + ', reessai plus tard');
                        break;
                    } else {
                        // Erreur client (400, 403...) : on retire pour eviter loop
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
        }
    }

    // ===== Badge online/offline + queue =====
    function ensureBadge() {
        var b = document.getElementById('pwaStatusBadge');
        if (b) return b;
        b = document.createElement('div');
        b.id = 'pwaStatusBadge';
        b.style.cssText =
            'position:fixed;top:10px;right:60px;z-index:10005;' +
            'display:flex;align-items:center;gap:6px;padding:5px 10px;' +
            'border-radius:14px;font:600 11px/1 Segoe UI,sans-serif;' +
            'background:rgba(255,255,255,0.92);box-shadow:0 1px 4px rgba(0,0,0,0.18);' +
            'cursor:pointer;user-select:none;';
        b.title = 'Cliquer pour gerer le mode hors-ligne';
        b.onclick = openOfflineMenu;
        document.body.appendChild(b);
        return b;
    }

    function updateStatusBadge() {
        var b = ensureBadge();
        var online = navigator.onLine;
        b.style.color = online ? '#2e7d32' : '#c62828';
        var dot = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' +
                  (online ? '#43a047' : '#e53935') + '"></span>';
        var label = online ? 'En ligne' : 'Hors ligne';
        // queue count appended async
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
            '<button id="pwaMPrecache" style="background:#8b4513;color:#fff;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-align:left;">Pre-charger la zone visible</button>' +
            '<button id="pwaMQueue" style="background:#5a3a1a;color:#fff;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-align:left;">Voir les modifs en attente</button>' +
            '<button id="pwaMReplay" style="background:#f5b041;color:#5a3a1a;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-align:left;">Forcer la synchro</button>' +
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

        document.getElementById('pwaMPrecache').onclick = function() { m.remove(); openPrecacheModal(); };
        document.getElementById('pwaMQueue').onclick = function() { m.remove(); openQueueDetailsModal(); };
        document.getElementById('pwaMReplay').onclick = function() {
            if (!navigator.onLine) { showToast('Pas de connexion reseau'); return; }
            replayQueue().then(function() { showToast('Synchro terminee'); m.remove(); });
        };
        document.getElementById('pwaMClear').onclick = function() {
            if (!confirm('Vider tout le cache offline ? Tu auras besoin de reseau au prochain demarrage.')) return;
            clearCache().then(function() { alert('Cache vide.'); m.remove(); });
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
            '<div style="font-size:10px;color:#999;margin-top:4px;">Astuce : active une couche dans la carte avant d\\'ouvrir ce modal pour qu\\'elle apparaisse cochee par defaut.</div>' +
            '</details>' +

            '<details style="margin-bottom:14px;border:1px solid #f0ebe3;border-radius:6px;padding:6px 12px;">' +
            '<summary style="font-size:12px;color:#5a3a1a;font-weight:600;cursor:pointer;padding:4px 0;">Projets a pre-cacher (' + allProjects.filter(function(p){return p.current;}).length + '/' + allProjects.length + ')</summary>' +
            '<div style="max-height:140px;overflow-y:auto;margin-top:6px;">' + projectsHtml + '</div>' +
            '<div style="font-size:10px;color:#999;margin-top:4px;">Pour chaque projet coche : les features (points/polygones) et photos seront mis en cache pour consultation offline.</div>' +
            '</details>' +

            '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;color:#5a3a1a;margin-bottom:12px;cursor:pointer;">' +
            '<input type="checkbox" id="pwaIncludeCorse" style="margin-top:2px;">' +
            '<span>Inclure le contexte Corse complet aux zooms 8-10 (~80 tuiles, ~3 Mo). Utile pour dezoomer voir l\\'ile entiere hors-ligne.</span>' +
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
            var summary = '<strong>' + totalTiles + ' tuiles</strong> (~' + estMo + ' Mo, ' + nLayers + ' couche(s)';
            if (includeCorse) summary += ' + contexte Corse';
            summary += ')';
            if (nProjects > 0) {
                summary += ' + <strong>' + nProjects + ' projet(s)</strong> (data Supabase + photos, taille variable)';
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

    // ===== Outil Leaflet.draw : tracer un rectangle pour la zone a pre-cacher =====
    function activateRectangleDraw(map) {
        if (typeof L === 'undefined' || !L.Draw || !L.Draw.Rectangle) {
            alert('Outil de dessin non disponible. Bascule sur la zone visible.');
            openPrecacheModal();
            return;
        }
        showToast('Dessine un rectangle sur la carte', 5000);
        var drawer = new L.Draw.Rectangle(map, {
            shapeOptions: { color: '#8b4513', weight: 2, fillOpacity: 0.15 }
        });
        drawer.enable();

        function onCreated(e) {
            map.off(L.Draw.Event.CREATED, onCreated);
            // Retirer le rectangle dessine apres recuperation des bounds
            var layer = e.layer;
            map.addLayer(layer);
            var b = layer.getBounds();
            setTimeout(function() { map.removeLayer(layer); }, 200);
            openPrecacheModal(b);
        }
        function onCancel() {
            map.off(L.Draw.Event.CREATED, onCreated);
            document.removeEventListener('keydown', onEsc);
        }
        function onEsc(e) {
            if (e.key === 'Escape') {
                drawer.disable();
                onCancel();
                openPrecacheModal();  // retour au modal sans bounds custom
            }
        }
        map.once(L.Draw.Event.CREATED, onCreated);
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
    // Folium attache les couches inactives au layer control. On les retrouve via
    // l'instance Leaflet du LayerControl (cherche dans window.*).
    function listAvailableLayers(map) {
        var out = [];
        var seen = new Set();
        // 1. Layers actifs (via eachLayer)
        map.eachLayer(function(l) {
            if (l instanceof L.TileLayer && l._url && l._url.indexOf('{z}') !== -1) {
                var id = L.stamp(l);
                if (!seen.has(id)) {
                    seen.add(id);
                    out.push({
                        id: id,
                        name: layerDisplayName(l),
                        url: l._url,
                        active: true
                    });
                }
            }
        });
        // 2. Layers inactifs (via le LayerControl Leaflet)
        for (var k in window) {
            try {
                var ctl = window[k];
                if (ctl && ctl._layers && typeof ctl._layers === 'object' && ctl.options && typeof ctl.options.position === 'string') {
                    var entries = ctl._layers;
                    // Array dans certaines versions Leaflet, object dans d'autres
                    var iter = Array.isArray(entries) ? entries : Object.values(entries);
                    iter.forEach(function(e) {
                        var lyr = e.layer;
                        if (!lyr || !(lyr instanceof L.TileLayer) || !lyr._url) return;
                        if (lyr._url.indexOf('{z}') === -1) return;
                        var id = L.stamp(lyr);
                        if (!seen.has(id)) {
                            seen.add(id);
                            out.push({
                                id: id,
                                name: e.name || layerDisplayName(lyr),
                                url: lyr._url,
                                active: false
                            });
                        }
                    });
                    break;
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
            if (!navigator.onLine) { showToast('Pas de reseau actuellement'); return; }
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

    // ===== Bootstrap =====
    window.addEventListener('load', function() {
        setTimeout(function() {
            updateStatusBadge();
            // Replay queue au demarrage si online
            if (navigator.onLine) setTimeout(replayQueue, 2000);
        }, 800);
    });
    window.addEventListener('online', function() {
        updateStatusBadge();
        setTimeout(replayQueue, 500);
    });
    window.addEventListener('offline', updateStatusBadge);

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
    window._pwa.toast = showToast;
})();
