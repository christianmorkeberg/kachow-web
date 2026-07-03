'use strict';

// Service worker for the static shell. Uses NETWORK-FIRST for our assets so a
// deploy is picked up on the next load (no hard refresh), with a cache fallback
// for offline. Never touches /api/ (dynamic, auth-scoped) or navigations — those
// always go straight to the network.

const CACHE = 'kachow-static-v2';
const ASSETS = [
    '/assets/styles.css',
    '/assets/app.js',
    '/assets/icon.svg',
    '/assets/icon-192.png',
    '/assets/icon-512.png',
    '/assets/manifest.json',
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    // Keep auth/data and page loads always fresh.
    if (url.pathname.startsWith('/api/') || req.mode === 'navigate') return;

    // Network-first for our known static assets: fresh when online (so deploys
    // land automatically), cached copy when offline.
    if (ASSETS.includes(url.pathname)) {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy));
                    return res;
                })
                .catch(() => caches.match(req))
        );
    }
});
