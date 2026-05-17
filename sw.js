/* ============================================================
   Service Worker — Toponymie Corse PWA
   ============================================================
   Strategie de cache :
   - HTML carte courante     : Stale-While-Revalidate (charge depuis cache
                                puis rafraichit en arriere-plan)
   - Libs CDN (jsdelivr, etc.): Cache-First (immuable par version)
   - Tuiles IGN/Esri/OSM     : Cache-First avec eviction LRU
                                (response opaque autorisee pour cross-origin)
   - API Supabase REST        : Network-First avec fallback cache
                                (toujours essayer reseau pour donnees fraiches)
   - Photos Supabase Storage  : Cache-First (immuables)
   - Tout autre (manifest...) : Network-First
   ============================================================ */

const VERSION = 'topo-v1';
const STATIC_CACHE = 'static-' + VERSION;
const TILE_CACHE = 'tiles-' + VERSION;
const API_CACHE = 'api-' + VERSION;
const PHOTO_CACHE = 'photos-' + VERSION;
const HTML_CACHE = 'html-' + VERSION;
// Contexte Corse telecharge a l'installation. Nom VOLONTAIREMENT sans suffixe
// de VERSION : il survit aux mises a jour du SW ET au vidage du cache, sauf si
// l'utilisateur choisit explicitement de le supprimer (wipeContext).
const CTX_CACHE = 'corse-context';

// Plus de plafond de tuiles : pas d'eviction LRU cote app. Seul le quota du
// navigateur peut evincer (sous pression disque). MAX_TILES conserve a titre
// indicatif mais N'EST PLUS applique.
const MAX_PHOTOS = 500;
const API_TTL = 24 * 60 * 60 * 1000;  // 24h

// Pre-cache au moment de l'install (libs critiques)
const PRECACHE = [
    'manifest.json',
    'icon-192.png',
    'icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => cache.addAll(PRECACHE).catch(() => null))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => !k.endsWith('-' + VERSION) && k !== CTX_CACHE)
                .map(k => caches.delete(k))
        )).then(() => self.clients.claim())
    );
});

// Helpers de routage
function isTileUrl(url) {
    return /data\.geopf\.fr\/wmts/.test(url)
        || /server\.arcgisonline\.com\/ArcGIS\/rest/.test(url)
        || /\.tile\.opentopomap\.org/.test(url)
        || /tile\.openstreetmap\.org/.test(url)
        || /raw\.githubusercontent\.com\/.+\/raster-tiles-corse/.test(url);
}

function isCdnLib(url) {
    return /cdn\.jsdelivr\.net/.test(url)
        || /unpkg\.com/.test(url)
        || /cdnjs\.cloudflare\.com/.test(url);
}

function isSupabaseApi(url) {
    return /supabase\.co\/rest\/v1\//.test(url);
}

function isSupabasePhoto(url) {
    return /supabase\.co\/storage\/v1\//.test(url);
}

function isHtmlCarte(url) {
    return /\/carte_polygones_.*\.html$/i.test(url) || /\.html$/i.test(new URL(url).pathname);
}

// LRU simple : limite la taille du cache en virant les plus anciennes entrees.
// Ne s'execute reellement qu'une fois sur N appels pour eviter de scanner
// le cache complet a chaque tuile (cache.keys() est O(N) sur certains devices).
// (trimCache supprime : plus de plafond/eviction LRU cote app. Le quota du
//  navigateur reste le seul garde-fou sous forte pression disque.)

// Helper offline : court-circuite le fetch reseau pour eviter timeouts longs.
// Inclut aussi le mode test simule (toggle SET_FORCE_OFFLINE depuis le client)
// pour que l'utilisateur puisse tester le rendu offline sans couper la 4G.
let _forcedOffline = false;
function _isOffline() { return !navigator.onLine || _forcedOffline; }

// Memoize caches.open() : evite d'ouvrir 50x par seconde sur device lent
const _cacheRefs = {};
function _getCache(name) {
    if (!_cacheRefs[name]) _cacheRefs[name] = caches.open(name);
    return _cacheRefs[name];
}

// === Stale-While-Revalidate ===
async function staleWhileRevalidate(request, cacheName) {
    const cache = await _getCache(cacheName);
    let cached = await cache.match(request);
    // Fallback tolerant (query string / hash differents) avant d'abandonner
    if (!cached) cached = await cache.match(request, { ignoreSearch: true });
    if (_isOffline()) {
        return cached || new Response(
            '<!DOCTYPE html><meta charset="utf-8"><body style="font:16px system-ui;padding:24px;color:#5a3a1a;">' +
            '<h2>Carte non disponible hors-ligne</h2>' +
            '<p>Cette carte n\'a pas encore ete mise en cache. Ouvre-la <b>une fois en ligne</b> ' +
            '(elle se mettra en cache automatiquement), puis tu pourras la relancer hors-ligne.</p></body>',
            { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const networkPromise = fetch(request).then(resp => {
        if (resp && resp.ok) cache.put(request, resp.clone()).catch(() => null);
        return resp;
    }).catch(() => null);
    return cached || networkPromise || new Response('Offline', { status: 503 });
}

// === Cache-First === (pour les tuiles - cache leger, fetch direct sans timeout)
async function cacheFirst(request, cacheName, opts = {}) {
    const cache = await _getCache(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    if (_isOffline()) return new Response('Offline (not cached)', { status: 503 });
    try {
        // Fetch direct, sans wrapping. Le browser a son propre timeout.
        // Cache async en BG : ne bloque pas la response.
        const resp = await fetch(request, opts);
        if (resp) cache.put(request, resp.clone()).catch(() => null);
        return resp;
    } catch (e) {
        return new Response('Offline tile', { status: 503 });
    }
}

// === Network-First === (pour API Supabase - timeout court car JSON petit)
async function networkFirst(request, cacheName) {
    const cache = await _getCache(cacheName);
    if (_isOffline()) {
        const cached = await cache.match(request);
        return cached || new Response(JSON.stringify({ offline: true }),
            { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    try {
        const resp = await fetch(request);
        if (resp && resp.ok) cache.put(request, resp.clone()).catch(() => null);
        return resp;
    } catch (e) {
        const cached = await cache.match(request);
        return cached || new Response(JSON.stringify({ offline: true, error: 'no network' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    // On ne gere que GET
    if (req.method !== 'GET') return;
    const url = req.url;

    // 1. Tuiles cartographiques externes
    // Strategie : en ONLINE, on respondWith via cache-first MAIS si cache miss,
    // on laisse le browser HTTP cache faire son job (pas de slowdown).
    // En OFFLINE, on tente le cache et 503 si miss.
    if (isTileUrl(url)) {
        event.respondWith((async () => {
            try {
                // Cache-first sur LES DEUX caches : tuiles normales + contexte
                // Corse installe (CTX_CACHE survit au vidage de cache).
                const tileCache = await _getCache(TILE_CACHE);
                const ctxCache = await _getCache(CTX_CACHE);
                let cached = await tileCache.match(req);
                if (!cached) cached = await ctxCache.match(req);
                if (cached) return cached;
                if (_isOffline()) {
                    return new Response('Offline (not cached)', { status: 503 });
                }
                // Online cache miss : fetch direct (browser HTTP cache prend
                // le relais). Cache async en BG dans TILE_CACHE (pas d'eviction).
                const resp = await fetch(req, { mode: 'no-cors' });
                if (resp) tileCache.put(req, resp.clone()).catch(() => null);
                return resp;
            } catch (e) {
                return new Response('Tile fetch failed', { status: 503 });
            }
        })());
        return;
    }

    // 2. Libs CDN (versionnees, immuables)
    if (isCdnLib(url)) {
        event.respondWith(cacheFirst(req, STATIC_CACHE));
        return;
    }

    // 3. API Supabase : reseau prioritaire, fallback cache
    if (isSupabaseApi(url)) {
        event.respondWith(networkFirst(req, API_CACHE));
        return;
    }

    // 4. Photos Supabase Storage : immuables
    if (isSupabasePhoto(url)) {
        event.respondWith(
            cacheFirst(req, PHOTO_CACHE)
                .finally(() => trimCache(PHOTO_CACHE, MAX_PHOTOS))
        );
        return;
    }

    // 5. HTML cartes : stale-while-revalidate
    if (isHtmlCarte(url)) {
        event.respondWith(staleWhileRevalidate(req, HTML_CACHE));
        return;
    }

    // 5bis. Assets same-origin (pwa-ui.js, css, icones, manifest...) :
    // stale-while-revalidate pour qu'ils soient dispo hors-ligne.
    // Sans ca, pwa-ui.js tombe en network-first -> 503 hors-ligne -> UI cassee.
    try {
        const _u = new URL(url);
        if (_u.origin === self.location.origin
            && /\.(js|css|png|jpg|jpeg|svg|json|webmanifest|woff2?)$/i.test(_u.pathname)) {
            event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
            return;
        }
    } catch (e) {}

    // 6. Reste : network-first par defaut
    event.respondWith(
        fetch(req).catch(() => caches.match(req).then(c => c || new Response('Offline', { status: 503 })))
    );
});

// === Background Sync API ===
// Permet de rejouer la queue IndexedDB des que le reseau revient, MEME si
// la page n'est plus ouverte. Le browser declenche l'event 'sync' avec le
// tag enregistre par le client. Supporte : Chrome Android, Edge, Samsung
// Internet. Pas supporte : Safari iOS, Firefox (fallback = sync visible).
const SYNC_DB = 'topo-sync';
const SYNC_STORE = 'queue';

function swDbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(SYNC_DB, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(SYNC_STORE)) {
                db.createObjectStore(SYNC_STORE, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function swDbAll() {
    const db = await swDbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SYNC_STORE, 'readonly');
        const req = tx.objectStore(SYNC_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

async function swDbDel(id) {
    const db = await swDbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SYNC_STORE, 'readwrite');
        const req = tx.objectStore(SYNC_STORE).delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// Deserialise un body stocke en IndexedDB en l'objet attendu par fetch.
function swDeserializeBody(s) {
    if (!s || s.type === 'null') return null;
    if (s.type === 'string') return s.value;
    if (s.type === 'blob') return s.value;
    if (s.type === 'formdata') {
        const fd = new FormData();
        (s.value || []).forEach(e => {
            if (e.kind === 'blob') fd.append(e.key, e.value, e.filename);
            else fd.append(e.key, e.value);
        });
        return fd;
    }
    return s.value || null;
}

async function swReplayQueue() {
    let items = await swDbAll();
    // Tri : storage avant rest pour le meme batch
    items.sort((a, b) => {
        if (Math.abs(a.createdAt - b.createdAt) < 500) {
            if (a.kind === 'storage' && b.kind !== 'storage') return -1;
            if (b.kind === 'storage' && a.kind !== 'storage') return 1;
        }
        return a.createdAt - b.createdAt;
    });
    console.log('[SW Sync] Replay : ' + items.length + ' op(s)');
    let processed = 0, dropped = 0;
    for (const it of items) {
        try {
            // Support legacy items (it.body) + new items (it.bodySer)
            const body = it.bodySer ? swDeserializeBody(it.bodySer) : (it.body || null);
            const resp = await fetch(it.url, {
                method: it.method,
                headers: it.headers,
                body: body
            });
            if (resp.ok || resp.status === 201 || resp.status === 204) {
                await swDbDel(it.id);
                processed++;
            } else if (resp.status >= 500 || resp.status === 429) {
                console.warn('[SW Sync] Server ' + resp.status + ', will retry');
                break;
            } else {
                console.warn('[SW Sync] Drop (status ' + resp.status + ') :', it.method, it.url);
                await swDbDel(it.id);
                dropped++;
            }
        } catch (e) {
            console.warn('[SW Sync] Network error, stop replay :', e.message);
            break;
        }
    }
    const clients = await self.clients.matchAll();
    const remaining = (await swDbAll()).length;
    clients.forEach(c => c.postMessage({
        type: 'QUEUE_SYNCED',
        processed: processed,
        dropped: dropped,
        remaining: remaining
    }));
    return { processed, dropped, remaining };
}

self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-queue') {
        console.log('[SW] Background Sync triggered (sync-queue)');
        event.waitUntil(swReplayQueue());
    }
});


// === Pre-cache une liste d'URLs (tuiles + photos) ===
// targetCacheName : TILE_CACHE par defaut, CTX_CACHE pour le contexte Corse
// installe (qui survit au vidage de cache).
async function precacheUrls(urls, port, targetCacheName) {
    const cache = await caches.open(targetCacheName || TILE_CACHE);
    let done = 0;
    const errors = [];
    // Limite la concurrence pour ne pas saturer le reseau / le serveur tuile
    const CONCURRENT = 8;
    let idx = 0;
    async function worker() {
        while (idx < urls.length) {
            const i = idx++;
            const u = urls[i];
            try {
                const existing = await cache.match(u);
                if (existing) { done++; continue; }
                const resp = await fetch(u, { mode: 'no-cors' });
                if (resp) await cache.put(u, resp);
                done++;
            } catch (e) {
                errors.push({ url: u, error: e.message });
            }
            // Progress chaque 50
            if (port && done % 50 === 0) {
                port.postMessage({ progress: done, total: urls.length });
            }
        }
    }
    const workers = [];
    for (let k = 0; k < CONCURRENT; k++) workers.push(worker());
    await Promise.all(workers);
    if (port) port.postMessage({ progress: done, total: urls.length, done: true, errors: errors.length });
}

// Message API pour permettre au client de declencher des actions
self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'SKIP_WAITING') self.skipWaiting();

    if (data.type === 'CLEAR_CACHE') {
        // Par defaut on PRESERVE le contexte Corse (cher a retelecharger).
        // Suppression seulement si l'utilisateur l'a explicitement demande.
        const wipeContext = data.wipeContext === true;
        caches.keys().then(keys => Promise.all(
            keys.filter(k => wipeContext || k !== CTX_CACHE)
                .map(k => caches.delete(k))
        )).then(() => event.ports[0] && event.ports[0].postMessage({
            cleared: true, contextKept: !wipeContext
        }));
    }

    if (data.type === 'CACHE_STATS') {
        Promise.all([
            caches.open(TILE_CACHE).then(c => c.keys().then(k => k.length)),
            caches.open(PHOTO_CACHE).then(c => c.keys().then(k => k.length)),
            caches.open(API_CACHE).then(c => c.keys().then(k => k.length)),
            caches.open(HTML_CACHE).then(c => c.keys().then(k => k.length)),
            caches.open(CTX_CACHE).then(c => c.keys().then(k => k.length)).catch(() => 0)
        ]).then(([tiles, photos, api, html, context]) => {
            event.ports[0] && event.ports[0].postMessage({ tiles, photos, api, html, context, version: VERSION });
        });
    }

    if (data.type === 'CACHE_PAGE' && data.url) {
        // Mise en cache EXPLICITE de la page courante (HTML) + de pwa-ui.js.
        // Indispensable : le 1er chargement d'une carte n'est pas intercepte
        // par le SW (pas encore actif), donc sans ca le HTML n'est jamais
        // cache et la carte est "Offline" au lancement hors-ligne.
        event.waitUntil((async () => {
            try {
                const cache = await caches.open(HTML_CACHE);
                const existing = await cache.match(data.url, { ignoreSearch: true });
                if (existing) {
                    event.ports[0] && event.ports[0].postMessage({ cached: true, already: true });
                    return;
                }
                const resp = await fetch(data.url, { cache: 'no-store' });
                if (resp && resp.ok) await cache.put(data.url, resp.clone());
                event.ports[0] && event.ports[0].postMessage({ cached: !!(resp && resp.ok) });
            } catch (e) {
                event.ports[0] && event.ports[0].postMessage({ cached: false, error: e.message });
            }
        })());
    }

    if (data.type === 'PRECACHE_URLS' && Array.isArray(data.urls)) {
        // event.waitUntil garde le SW vivant pendant tout le pre-cache, meme
        // si l'utilisateur passe l'app en arriere-plan ou ferme l'onglet.
        // Le browser garantit que le SW ne sera pas tue avant la fin de la
        // promise. Indispensable pour les gros telechargements (1000+ tuiles).
        event.waitUntil(precacheUrls(data.urls, event.ports[0],
            data.context === true ? CTX_CACHE : TILE_CACHE));
    }

    if (data.type === 'REPLAY_QUEUE') {
        swReplayQueue().then(r => {
            event.ports[0] && event.ports[0].postMessage(r);
        });
    }

    if (data.type === 'GET_QUEUE') {
        swDbAll().then(items => {
            event.ports[0] && event.ports[0].postMessage({ items });
        });
    }

    if (data.type === 'DELETE_QUEUE_ITEM' && typeof data.id !== 'undefined') {
        swDbDel(data.id).then(() => {
            event.ports[0] && event.ports[0].postMessage({ deleted: true });
        });
    }

    if (data.type === 'SET_FORCE_OFFLINE') {
        _forcedOffline = !!data.value;
        console.log('[SW] Mode test offline =', _forcedOffline);
    }
});
