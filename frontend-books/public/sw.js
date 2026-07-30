/* Офлайн: книги и файлы сборки кладём в кэш насовсем (их имена неизменны — хеш или id
   книги), остальное — сеть с откатом в кэш, иначе после каждой выкладки пришлось бы
   объяснять браузеру, что он устарел. */
const CACHE = 'books-2';
/* Навсегда — только неизменное: файлы сборки (хеш в имени) и содержимое книги (id в пути).
   Прогресс и выписки (/books/<id>/state) сюда попадать не должны: закэшированное навсегда
   состояние — это книга, которая на телефоне навсегда осталась там, где её открыли впервые. */
const FOREVER = /\/assets\/|\/books\/[^/]+\/(file|cover|thumb)\b|icon-\d+\.png$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // бэкенд агента не кэшируем никогда

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
      const hit = await caches.match(req);
      if (hit) return hit;
      return caches.match('index.html');
    }
  })());
});
