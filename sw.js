// VERAQIS Studio — service worker.
//
// Allowlist caching only. This worker knows the exact list of application files
// it may cache and refuses everything else, so no user archive, report, export,
// blob URL or filename can enter the cache — by construction, not by policy.
//
// Deliberately NOT cached: anything not in PRECACHE, any cross-origin request,
// any non-GET request, blob: and data: URLs, and the APK (a 1.1 MB binary that
// belongs to the download page, not the app shell).

const VERSION = 'v1';
const CACHE = `veraqis-studio-${VERSION}`;

// The complete application shell. Every entry is same-origin and static.
const PRECACHE = [
  '/studio/',
  '/studio/new/',
  '/studio/reports/',
  '/studio/settings/',
  '/studio/project/',
  '/tools/zip-checker/',
  '/assets/veraqis.css',
  '/assets/favicon.svg',
  '/assets/studio/app.js',
  '/assets/studio/worker.js',
  '/assets/studio/supervisor.js',
  '/assets/studio/engine.js',
  '/assets/studio/protocol.js',
  '/assets/studio/errors.js',
  '/assets/studio/capabilities.js',
  '/assets/studio/messages.js',
  '/assets/studio/project.js',
  '/assets/studio/store.js',
  '/assets/studio/ui.js',
  '/assets/studio/register-sw.js',
  '/assets/zip-checker/zip-core.js',
  '/assets/zip-checker/app.js',
  '/assets/zip-checker/worker.js',
  '/manifest.webmanifest',
  '/studio/offline/',
];

const ALLOWED = new Set(PRECACHE);

// addAll is atomic: one 404 would leave the shell half-cached, so each entry is
// added individually and a missing optional file cannot block the install.
async function primeCache() {
  const cache = await caches.open(CACHE);
  const results = await Promise.all(PRECACHE.map(async (url) => {
    try {
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok && res.type === 'basic') { await cache.put(url, res); return true; }
    } catch { /* offline; the runtime handler fills it on the next visit */ }
    return false;
  }));
  return results.filter(Boolean).length;
}

self.addEventListener('install', (event) => {
  // Do NOT skipWaiting: an update must not swap the app out from under a running
  // analysis. The page asks for activation when it is safe.
  event.waitUntil(primeCache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('veraqis-studio-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // The page controls activation, so an update never interrupts work in flight.
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'VERSION') {
    event.source.postMessage({ type: 'VERSION', version: VERSION, cache: CACHE });
  }
  // "Delete all local data" clears every veraqis-* cache, which is right — the
  // user asked for it. But the app shell is application code, not user data, so
  // offline capability must come back rather than silently disappearing until
  // the next service-worker update.
  if (event.data && event.data.type === 'PRIME') {
    event.waitUntil((async () => {
      const n = await primeCache();
      if (event.source) event.source.postMessage({ type: 'PRIMED', cached: n });
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only GET. A POST could carry a body; nothing here should ever see one.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only. A cross-origin response would be opaque and must never be
  // cached — and this site loads nothing cross-origin anyway.
  if (url.origin !== self.location.origin) return;

  // blob: and data: never reach here as same-origin http(s), but be explicit.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  // Ignore query strings entirely for cache lookup so a crafted ?x=… cannot
  // create an unbounded number of cache entries (cache-poisoning by growth).
  const path = url.pathname;
  if (!ALLOWED.has(path)) {
    // Not part of the app shell: go to the network, cache nothing. If the
    // network fails on a navigation, show the offline page instead of a
    // browser error.
    if (req.mode === 'navigate') {
      event.respondWith((async () => {
        try { return await fetch(req); }
        catch {
          const cache = await caches.open(CACHE);
          return (await cache.match('/studio/offline/')) || new Response(
            'Offline and this page is not part of the offline app.',
            { status: 503, headers: { 'Content-Type': 'text/plain' } }
          );
        }
      })());
    }
    return;
  }

  // Allowlisted shell file: cache first, then revalidate in the background so
  // an update is picked up without ever blocking the user on the network.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(path);
    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(path, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    if (cached) { event.waitUntil(network); return cached; }
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') {
      return (await cache.match('/studio/offline/')) || new Response('Offline.', { status: 503 });
    }
    return new Response('Offline.', { status: 503 });
  })());
});
