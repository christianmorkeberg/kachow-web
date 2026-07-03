'use strict';

// Minimal service worker: precache the static shell for installability and
// offline asset loading. Never caches /api/ (dynamic, auth-scoped) or the
// authenticated HTML pages — those always go to the network.

const CACHE = 'kachow-static-v1';
const ASSETS = [
    '/assets/styles.css',
    '/assets/app.js',
    '/assets/icon.svg',
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

    // Never intercept API calls or navigations — keep auth/data always fresh.
    if (url.pathname.startsWith('/api/') || req.mode === 'navigate') return;

    // Cache-first for our known static assets.
    if (ASSETS.includes(url.pathname)) {
        event.respondWith(
            caches.match(req).then((hit) => hit || fetch(req).then((res) => {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(req, copy));
                return res;
            }))
        );
    }
});
