/* =============================================================================
   link_sw.js — Campistry Link service worker
   Makes the parent portal installable and instant-loading.
   Strategy:
     - HTML: network-first (always fresh portal, cached copy as offline fallback)
     - Static assets (css/js/png/fonts): stale-while-revalidate
     - Never touches Supabase / API calls (different origin — skipped entirely)
   ============================================================================= */

var CACHE = 'campistry-link-v1';

var PRECACHE = [
    'campistry_link_parent.html',
    'campistry_link.css',
    'campistry-unified.css',
    'Link_clean.png',
    'link_icon_192.png',
    'link_icon_512.png'
];

self.addEventListener('install', function (e) {
    e.waitUntil(
        caches.open(CACHE).then(function (c) {
            // Best-effort precache — a single 404 must not break install
            return Promise.all(PRECACHE.map(function (url) {
                return c.add(url).catch(function () {});
            }));
        }).then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (e) {
    e.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(keys.filter(function (k) {
                return k.indexOf('campistry-link-') === 0 && k !== CACHE;
            }).map(function (k) { return caches.delete(k); }));
        }).then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function (e) {
    var req = e.request;
    if (req.method !== 'GET') return;

    var url = new URL(req.url);
    if (url.origin !== self.location.origin) return; // Supabase, fonts CDN, etc.

    var isHTML = req.mode === 'navigate' || /\.html$/.test(url.pathname);

    if (isHTML) {
        // Network-first: fresh app when online, cached shell when offline
        e.respondWith(
            fetch(req).then(function (res) {
                var copy = res.clone();
                caches.open(CACHE).then(function (c) { c.put(req, copy); });
                return res;
            }).catch(function () {
                return caches.match(req);
            })
        );
        return;
    }

    if (/\.(css|js|png|jpg|jpeg|svg|webp|woff2?)$/.test(url.pathname)) {
        // Stale-while-revalidate: instant loads, quietly refreshed
        e.respondWith(
            caches.match(req).then(function (cached) {
                var fetched = fetch(req).then(function (res) {
                    if (res && res.status === 200) {
                        var copy = res.clone();
                        caches.open(CACHE).then(function (c) { c.put(req, copy); });
                    }
                    return res;
                }).catch(function () { return cached; });
                return cached || fetched;
            })
        );
    }
});
