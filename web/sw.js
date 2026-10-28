/* sw.js — Service Worker
 * 壳（HTML/CSS/JS/图标）预缓存，词库分片按需缓存（内容只读，cache-first）。
 * 这样手机断网也能背单词。
 */
const CACHE = "momo-__VER__";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "store.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-mask.png",
  "data/meta.json",
  "data/algo.json",
  "data/seed.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) =>
      Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 页面导航：网络优先，断网回退缓存
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((r) => {
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put("./", cp)).catch(() => {});
        return r;
      }).catch(() => caches.match("./").then((r) => r || caches.match("index.html")))
    );
    return;
  }

  // 词库分片：缓存优先（内容不变）
  if (url.pathname.indexOf("/data/") >= 0) {
    e.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((r) => {
          if (r.ok) {
            const cp = r.clone();
            caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {});
          }
          return r;
        });
      })
    );
    return;
  }

  // 其它静态资源：stale-while-revalidate
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((r) => {
        if (r.ok) {
          const cp = r.clone();
          caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {});
        }
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
