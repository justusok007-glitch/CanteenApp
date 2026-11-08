// Keeps the app files on the phone so Canteen Record opens without internet.
// Own files: network first (always fresh when online, saved copy when not). Fonts and libraries: saved copy first.
const V = 'canteen-shell-v1';
const OWN = self.location.origin;
const CDN = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil((async function () {
    const c = await caches.open(V);
    try {
      const r = await fetch('./index.html', { cache: 'reload' });
      const html = await r.clone().text();
      await c.put('./index.html', r);
      const urls = Array.from(html.matchAll(/(?:src|href)="([^"#]+)"/g)).map(function (m) { return m[1]; })
        .filter(function (u) { return !/^(data:|mailto:)/.test(u); });
      await Promise.all(urls.map(function (u) { return c.add(new Request(u, { mode: 'cors' })).catch(function () {}); }));
    } catch (err) { /* offline install: the next visit will fill the cache */ }
  })());
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k.indexOf('canteen-shell-') === 0 && k !== V; }).map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});

function withTimeout(p, ms) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('slow')); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === OWN;
  if (!own && CDN.indexOf(url.hostname) === -1) return;   // data calls (Supabase) are handled by the app itself

  if (own) {
    e.respondWith((async function () {
      const c = await caches.open(V);
      try {
        const res = await withTimeout(fetch(req), 4000);
        if (res && res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        return (await c.match(req)) || (await c.match(req, { ignoreSearch: true })) ||
          (req.mode === 'navigate' ? await c.match('./index.html') : undefined) || Response.error();
      }
    })());
  } else {
    e.respondWith((async function () {
      const c = await caches.open(V);
      const hit = await c.match(req);
      if (hit) { fetch(req).then(function (res) { if (res && res.ok) c.put(req, res); }).catch(function () {}); return hit; }
      const res = await fetch(req);
      if (res && res.ok) c.put(req, res.clone());
      return res;
    })());
  }
});
