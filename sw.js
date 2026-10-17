// App shell cache for the video downloader. Only same-origin GETs inside this
// app's folder are cached; API calls and downloads always go to the network.
const CACHE = "video-dl-v48";
const BASE = new URL("./", self.location).pathname;
const SHELL = [BASE, BASE + "i18n.js", BASE + "manifest.json", BASE + "icon-192.png", BASE + "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("video-dl-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin || !u.pathname.startsWith(BASE)) return;
  // Newest copy from the network when it answers within 3 seconds (so updates show up
  // at once); otherwise the saved copy, so the app still opens fast on a slow line or offline.
  // Pages share one cache entry, so a shared link (?url=...) opens the same saved page.
  const key = req.mode === "navigate" ? BASE : req;
  const fresh = fetch(req).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return r;
  });
  e.waitUntil(fresh.then(() => {}, () => {}));
  const late = new Promise(res => setTimeout(res, 3000)).then(() => caches.match(key));
  e.respondWith(Promise.race([fresh.catch(() => caches.match(key)), late.then(hit => hit || fresh)])
    .then(r => r || fresh));
});

// Background downloads (started by the page when the app is closed mid-download).
// When the phone has the whole file, store it in the app's database like an in-app download.
const dbOpen = () => new Promise((ok, no) => {
  const r = indexedDB.open("vdl", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("files", { keyPath: "id" });
  r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
});
const dbDo = (mode, fn) => dbOpen().then(db => new Promise((ok, no) => {
  const t = db.transaction("files", mode), q = fn(t.objectStore("files"));
  t.oncomplete = () => ok(q && q.result); t.onerror = () => no(t.error);
}));
const tell = id => self.clients.matchAll({ includeUncontrolled: true }).then(cs => cs.forEach(c => c.postMessage({ vdl: "bg", id })));

self.addEventListener("backgroundfetchsuccess", e => {
  const reg = e.registration;
  if (!reg.id.startsWith("vdl-")) return;
  const id = reg.id.slice(4);
  e.waitUntil((async () => {
    const rec = await dbDo("readonly", s => s.get(id));
    if (!rec) return;
    const one = (await reg.matchAll())[0];
    const res = one && await one.responseReady;
    let blob = res && res.ok ? await res.blob() : null;
    if (blob && res.status === 206 && rec.partial) blob = new Blob([rec.partial, blob], { type: blob.type || "video/mp4" });
    else if (blob && res.status === 206) blob = null;   // only the end of a file we no longer have the start of
    if (blob && blob.size) {
      Object.assign(rec, { blob, status: "done", partial: null, got: blob.size, size: blob.size, autoSave: true, bgOffset: 0 });
      await e.updateUI({ title: "✓ " + (rec.title || "Video") });
    } else {
      rec.status = "queued";   // the app continues it the next time it is opened
    }
    await dbDo("readwrite", s => s.put(rec));
    await tell(id);
  })());
});

const bgStopped = e => {
  const reg = e.registration;
  if (!reg.id.startsWith("vdl-")) return;
  const id = reg.id.slice(4);
  e.waitUntil((async () => {
    const rec = await dbDo("readonly", s => s.get(id));
    if (rec && rec.status === "bg") {
      rec.status = e.type === "backgroundfetchabort" ? "paused" : "queued";
      rec.got = rec.partial ? rec.partial.size : 0;
      await dbDo("readwrite", s => s.put(rec));
    }
    await tell(id);
  })());
};
self.addEventListener("backgroundfetchfail", bgStopped);
self.addEventListener("backgroundfetchabort", bgStopped);

// Tapping the download notification opens "my files".
self.addEventListener("backgroundfetchclick", e => {
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow(BASE + "#files")));
});
