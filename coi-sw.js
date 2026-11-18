// Cross-origin isolation for static hosting (GitHub Pages cannot send these headers itself).
// The page's own document comes back with COOP + COEP headers added, so the browser treats the page
// as cross-origin isolated and the Rive runtime can use its threads (less work on the main thread).
// Only the page itself is touched; every other request goes straight to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.mode !== 'navigate') return;
  e.respondWith((async () => {
    const res = await fetch(req);
    if (!res || res.status === 0 || res.type === 'opaque') return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  })());
});
