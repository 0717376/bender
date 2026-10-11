/* Офлайн для зала: оболочка приложения открывается без сети, а подходы копятся в очереди
   (src/live.ts) и уходят, когда связь вернётся. Файлы сборки кладём в кэш насовсем — у них
   хеш в имени, — и кадры упражнений тоже: карточку техники открывают у тренажёра; страницу берём из сети с откатом в кэш, иначе после каждой выкладки пришлось
   бы объяснять браузеру, что он устарел. */
const CACHE = 'fit-1';
const FOREVER = /\/assets\/|^\/ex\/|icon-\d+\.png$/;
/* Живое — мимо кэша вовсе: ответы бэкенда устаревают сразу, а поток событий ещё и бесконечный.
   Что показывать без сети, приложение решает само. */
const LIVE = /^\/(fit|auth|chat|api)(\/|$)/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || LIVE.test(url.pathname)) return;

  if (FOREVER.test(url.pathname)) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch {
      return (await caches.match(req)) || (await caches.match('/')) || Response.error();
    }
  })());
});
