// Golf Buddy service worker (hosted copy only; the Claude artifact never has one). Lets the page open with poor or
// no signal: the page is network-first with a short wait before the cached copy is used, and the cached copy is
// replaced whenever the network answers, so a stale app is never served for longer than one visit. The icons and
// the manifest are cache-first. The build fills in the cache version from a hash of the site's files.
const CACHE = 'golf-buddy-__VERSION__';
const WAIT_MS = 3000;
const ASSETS = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const scope = self.registration.scope;               // ends in "/": the folder the site is served from
const PAGE = scope;                                  // the page is cached under the scope URL itself

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll([PAGE, ...ASSETS.map((a) => new URL(a, scope).href)]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(scope)) return;
  const path = req.url.slice(scope.length).split(/[?#]/)[0];
  if (req.mode === 'navigate' || path === '' || path === 'index.html') { event.respondWith(page(event)); return; }
  if (ASSETS.includes(path)) event.respondWith(asset(req));
});

/** Network first; after WAIT_MS (or a network error) the cached page. The cache is refreshed whenever the network
 *  answers, even if that is after the cached copy was shown. */
async function page(event) {
  const cache = await caches.open(CACHE);
  const fresh = fetch(event.request.url, { cache: 'no-store' }).then(async (res) => {
    if (res.ok) await cache.put(PAGE, res.clone());
    return res;
  });
  event.waitUntil(fresh.catch(() => {}));
  const timeout = new Promise((done) => setTimeout(done, WAIT_MS, null));
  const first = await Promise.race([fresh.catch(() => null), timeout]);
  if (first && first.ok) return first;
  const cached = await cache.match(PAGE);
  if (cached) return cached;
  return first ?? fresh;                             // nothing cached yet: wait for the network after all
}

async function asset(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}
