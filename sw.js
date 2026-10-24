// App shell cache for the video downloader. Only same-origin GETs inside this
// app's folder are cached; API calls and downloads always go to the network.
const CACHE = "video-dl-v95";
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
  if (u.pathname.startsWith(BASE + "api/") || u.pathname.startsWith("/api/") || req.headers.has("range")) return;   // API calls, downloads: always live
  // Saved copy at once (the app opens instantly, even on a slow line); the newest copy is
  // fetched meanwhile for next time. Updates also arrive with each new version of this file,
  // which reloads the app (see index.html).
  // Pages share one cache entry, so a shared link (?url=...) opens the same saved page.
  const key = req.mode === "navigate" ? BASE : req;
  const fresh = fetch(req).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return r;
  });
  e.waitUntil(fresh.then(() => {}, () => {}));
  e.respondWith(caches.match(key).then(hit => hit || fresh));
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

// The page may split a background download into pieces (Range requests of 16 MB), so a cut
// line or the server's time limit only costs one piece. Joins, in order, the pieces that
// arrived whole, continuing from what the app already had.
async function pieces(reg, rec, all) {
  const recs = await reg.matchAll();
  const items = await Promise.all(recs.map(async x => {
    const m = /bytes=(\d+)-/.exec(x.request.headers.get("Range") || "");
    let res = null; try { res = await x.responseReady; } catch {}
    return { at: m ? +m[1] : 0, ranged: !!m, res };
  }));
  items.sort((p, q) => p.at - q.at);
  // One plain request: the whole file (or nothing).
  if (items.length === 1 && !items[0].ranged) {
    const res = items[0].res;
    return res && res.ok && res.status !== 206 ? { blob: await res.blob(), whole: true } : null;
  }
  const have = rec.partial ? [rec.partial] : [];
  let pos = rec.partial ? rec.partial.size : 0, type = "video/mp4", whole = true;
  for (const it of items) {
    if (it.res && it.res.status === 416) break;   // past the end of the file
    if (!it.res || it.res.status !== 206 || it.at !== pos) { whole = false; break; }
    const b = await it.res.blob().catch(() => null);
    if (!b) { whole = false; break; }
    if (!b.size) break;
    have.push(b); pos += b.size; type = b.type || type;
  }
  if (!all) whole = false;
  return { blob: new Blob(have, { type }), whole };
}

self.addEventListener("backgroundfetchsuccess", e => {
  const reg = e.registration;
  if (!reg.id.startsWith("vdl-")) return;
  const id = reg.id.slice(4);
  e.waitUntil((async () => {
    const rec = await dbDo("readonly", s => s.get(id));
    if (!rec) return;
    const got = await pieces(reg, rec, true);
    if (got && got.whole && got.blob.size && (!rec.size || got.blob.size >= rec.size)) {
      Object.assign(rec, { blob: got.blob, status: "done", partial: null, got: got.blob.size, size: got.blob.size, autoSave: true, bgOffset: 0 });
      await e.updateUI({ title: "✓ " + (rec.title || "Video") });
    } else {
      if (got && got.blob.size > (rec.partial ? rec.partial.size : 0)) { rec.partial = got.blob; }
      rec.got = rec.partial ? rec.partial.size : 0;
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
      // Keep the pieces that did arrive: the app continues after them, not from the start.
      const got = await pieces(reg, rec, false).catch(() => null);
      if (got && !got.whole && got.blob.size > (rec.partial ? rec.partial.size : 0)) rec.partial = got.blob;
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

// Tapping our own progress / "done" notification: open "my files" in the app.
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    if (cs.length) { cs[0].postMessage("vdl-files"); return cs[0].focus(); }
    return self.clients.openWindow(BASE + "#files");
  }));
});
