'use strict';

// Service worker for the static shell. Uses NETWORK-FIRST for our assets so a
// deploy is picked up on the next load (no hard refresh), with a cache fallback
// for offline. Never touches /api/ (dynamic, auth-scoped) or navigations — those
// always go straight to the network.

const CACHE = 'kachow-static-v2';
// A tapped notification is also parked here, so the page can pick it up on load / when it
// becomes visible — iOS often drops the postMessage to a suspended or discarded page.
const PENDING_CACHE = 'kachow-pending';
const PENDING_KEY = '/__pending-open';
const ASSETS = [
    '/assets/styles.css',
    '/assets/app.js',
    '/assets/icons.js',
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
            Promise.all(keys.filter((k) => k !== CACHE && k !== PENDING_CACHE).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// ---------- Push notifications ----------
self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
    const title = data.title || 'Kachow';
    const options = {
        body: data.body || '',
        icon: '/assets/icon-192.png',
        badge: '/assets/icon-192.png',
        data: { url: data.url || '/', type: data.type || '' },
        tag: data.type || 'kachow',   // same type replaces, doesn't stack
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const n = event.notification;
    const data = n.data || {};
    // What the page needs to open the right view AND show what the notification said.
    const pending = {
        url: data.url || '/',
        type: data.type || '',
        title: n.title || '',
        body: n.body || '',
        at: Date.now(),
    };
    event.waitUntil((async () => {
        try {
            const c = await caches.open(PENDING_CACHE);
            await c.put(PENDING_KEY, new Response(JSON.stringify(pending), { headers: { 'Content-Type': 'application/json' } }));
        } catch (e) { /* storage unavailable — the message below still tries */ }
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (clients.length) {
            // An already-open window (esp. an iOS PWA) often ignores client.navigate(), so
            // hand EVERY window the details (one may be a stale, discarded page), then focus.
            const msg = { type: 'kachow-open', ntype: pending.type, url: pending.url, title: pending.title, body: pending.body, at: pending.at };
            clients.forEach((client) => client.postMessage(msg));
            const target = clients.find((c) => c.focused) || clients[0];
            if ('focus' in target) return target.focus();
            return undefined;
        }
        // Nothing open → launch fresh at the deep link (the page also reads the parked copy).
        return self.clients.openWindow(pending.url);
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    // Keep auth/data and page loads always fresh.
    if (url.pathname.startsWith('/api/') || req.mode === 'navigate') return;

    // Network-first for our known static assets: fresh when online (so deploys
    // land automatically), cached copy when offline. ignoreSearch so a versioned
    // "?v=123" request still matches the precached copy offline.
    if (ASSETS.includes(url.pathname)) {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy));
                    return res;
                })
                .catch(() => caches.match(req, { ignoreSearch: true }))
        );
    }
});
