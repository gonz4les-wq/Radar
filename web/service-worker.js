/*
 * service-worker.js — offline shell cache for WiFi Activity Radar.
 *
 * Strategy:
 *   - Pre-cache the static shell on install.
 *   - Network-first for navigation (always try to get a fresh HTML),
 *     fall back to the cached shell when offline.
 *   - Stale-while-revalidate for same-origin GET assets.
 *   - Bypass cross-origin requests and non-GET methods entirely so
 *     things like the WebSocket telemetry stream are never touched.
 */

const CACHE_NAME = "radar-shell-v1";
const SHELL_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./radar.js",
  "./manifest.json",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigation: network-first, fall back to cached shell.
  if (
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html")
  ) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return resp;
        })
        .catch(() =>
          caches
            .match(req)
            .then((cached) => cached || caches.match("./index.html"))
        )
    );
    return;
  }

  // Same-origin assets: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") {
    self.skipWaiting();
  }
});
