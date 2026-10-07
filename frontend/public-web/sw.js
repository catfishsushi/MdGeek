// The service worker: keeps MdGeek's own files on the PC so the installed app starts with no network.
// It never sees the user's documents; those are read straight from disk through file handles.
//
// The build replaces __VERSION__ with a hash of index.html, so every release changes this file and
// the browser installs the new version. A new version waits until every MdGeek window is closed (or
// the user clicks Reload in the "new version" message), so code is never swapped under unsaved edits.
const VERSION = '__VERSION__';
const CACHE = `mdgeek-${VERSION}`;
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'].map(
  (f) => new URL(f, self.registration.scope).href,
);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('mdgeek-') && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

// Sent by the page when the user clicks Reload in the "new version" message, after saving.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'activate-now') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Ignore the query string so "./?source=pwa" style start URLs still match.
  const url = new URL(req.url);
  url.search = '';
  if (!FILES.includes(url.href)) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => (await cache.match(url.href)) ?? fetch(req)),
  );
});
