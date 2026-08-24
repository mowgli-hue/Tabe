// Minimal service worker: enough for browsers to consider Tabe installable.
// Caches the app shell (HTML + manifest + icons). API traffic always goes to network.
const CACHE = "vlink-shell-v2";
const SHELL = [
  "/",
  "/app",
  "/index.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon-32.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache API — always fresh
  if (url.pathname.startsWith("/api/")) return;
  // Only handle same-origin GET requests
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  // Network-first for the app shell so updates ship instantly, cache fallback for offline
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE).then((c) => c.put(event.request, clone)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match("/")))
  );
});
