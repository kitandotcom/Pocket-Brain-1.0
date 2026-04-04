const CACHE = "pb-v1";
const ASSETS = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  // Don't cache API calls or Supabase
  if (e.request.url.includes("/api/") || e.request.url.includes("supabase")) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
