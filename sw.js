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

const MAX_TILES = 4000;   // ~80-200 Mo selon le device
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
            keys.filter(k => !k.endsWith('-' + VERSION))
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

// LRU simple : limite la taille du cache en virant les plus anciennes entrees
async function trimCache(cacheName, maxEntries) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxEntries) {
        const toDelete = keys.length - maxEntries;
        await Promise.all(keys.slice(0, toDelete).map(k => cache.delete(k)));
    }
}

// === Stale-While-Revalidate ===
async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    const networkPromise = fetch(request).then(resp => {
        if (resp && resp.ok) cache.put(request, resp.clone());
        return resp;
    }).catch(() => null);
    return cached || networkPromise || new Response('Offline', { status: 503 });
}

// === Cache-First ===
async function cacheFirst(request, cacheName, opts = {}) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
        const resp = await fetch(request, opts);
        // Pour les tuiles cross-origin, on accepte les reponses opaques
        if (resp) cache.put(request, resp.clone()).catch(() => null);
        return resp;
    } catch (e) {
        return new Response('Offline tile', { status: 503 });
    }
}

// === Network-First ===
async function networkFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
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

    // 1. Tuiles cartographiques externes -> cache-first opaque
    if (isTileUrl(url)) {
        event.respondWith(
            cacheFirst(req, TILE_CACHE, { mode: 'no-cors' })
                .finally(() => trimCache(TILE_CACHE, MAX_TILES))
        );
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

    // 6. Reste : network-first par defaut
    event.respondWith(
        fetch(req).catch(() => caches.match(req).then(c => c || new Response('Offline', { status: 503 })))
    );
});

// Message API pour permettre au client de declencher des actions
self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'SKIP_WAITING') self.skipWaiting();
    if (data.type === 'CLEAR_CACHE') {
        caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
            .then(() => event.ports[0] && event.ports[0].postMessage({ cleared: true }));
    }
    if (data.type === 'CACHE_STATS') {
        Promise.all([
            caches.open(TILE_CACHE).then(c => c.keys().then(k => k.length)),
            caches.open(PHOTO_CACHE).then(c => c.keys().then(k => k.length)),
            caches.open(API_CACHE).then(c => c.keys().then(k => k.length)),
            caches.open(HTML_CACHE).then(c => c.keys().then(k => k.length))
        ]).then(([tiles, photos, api, html]) => {
            event.ports[0] && event.ports[0].postMessage({ tiles, photos, api, html, version: VERSION });
        });
    }
});
