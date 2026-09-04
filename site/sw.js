// Shell cache only. There is no precache list on purpose: this app has no bundler and twenty
// unversioned modules, so a hand-written manifest would rot the first time one was renamed.
// Everything is cached as it is fetched, and the network still wins whenever it answers.
const VER = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE = `wd-shell-${VER}`;

// The API surface. None of it is ever cached or intercepted: /events is an open SSE stream,
// /history streams CSV, /config carries the token, and a stale copy of any of them is a bug.
const API = /^\/(api|events|config|config-public|udp|history|history\.csv|diag|health|ingest|alerts|ha|discover|backup(?:\.db|\.wdbak)|restore|proxy)(\/|$|\?)/;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('wd-shell-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || API.test(url.pathname)) return;

  const dest = req.destination;
  // Icons and fonts never change under a given URL; anything that is code or markup must not be
  // pinned by a cache, or a fixed bug could stay fixed only on the machines that never went offline.
  const cacheFirst = dest === 'image' || dest === 'font';

  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (cacheFirst && hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      if (hit) return hit;
      throw err;
    }
  })());
});
