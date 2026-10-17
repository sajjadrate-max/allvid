// App shell cache for the video downloader. Only same-origin GETs inside this
// app's folder are cached; API calls and downloads always go to the network.
const CACHE = "video-dl-v25";
const BASE = new URL("./", self.location).pathname;
const SHELL = [BASE, BASE + "i18n.js", BASE + "manifest.json", BASE + "icon-192.png", BASE + "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("video-dl-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin || !u.pathname.startsWith(BASE)) return;
  // Open straight from the cache (fast, e.g. when picked from another app's Share menu)
  // and fetch the newest copy in the background for next time. Pages share one cache
  // entry, so a shared link (?url=...) opens the same saved page.
  const key = req.mode === "navigate" ? BASE : req;
  const fresh = fetch(req).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return r;
  });
  e.waitUntil(fresh.then(() => {}, () => {}));
  e.respondWith(caches.match(key).then(hit => hit || fresh));
});
