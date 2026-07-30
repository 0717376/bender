import { API, ls } from './core.js'
import { auth } from './auth.js'
import { fileGet, filePut, lib, saveLib } from './store.js'
import { applyPosition } from './sync.js'

/* ── Библиотека ──
   Книгами владеет сервер: список, файлы и обложки живут в корне books/. Локально
   держим только копию списка (полка рисуется сразу, ещё до ответа сервера) и сами файлы
   в IndexedDB — чтобы читать в самолёте. */

const head = () => ({ Authorization: 'Bearer ' + auth.token });

/** Обложка и файл открываются как обычные ссылки — токен в query, заголовок им не поставить. */
const link = (id, what) => `${API}/books/${id}/${what}?token=${encodeURIComponent(auth.token || '')}`;
export const coverUrl = e => link(e.id, e.thumb ? 'thumb' : 'cover');

const THUMB_W = 300;

/** Ужать обложку до полки. Делает это устройство, которое книгу добавило: серверу для
    этого понадобилась бы библиотека картинок, а здесь уже есть canvas. */
async function shrink(url) {
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => res(i); i.onerror = rej; i.src = url;
  });
  if (!img.width || !img.height) throw new Error('пустая обложка');
  const c = document.createElement('canvas');
  c.width = Math.min(THUMB_W, img.width);
  c.height = Math.round(img.height * (c.width / img.width));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res, rej) =>
    c.toBlob(b => (b ? res(b) : rej(new Error('canvas молчит'))), 'image/jpeg', 0.78));
}

/** Досылка миниатюр: у книг, добавленных до этой версии, их нет. */
export async function ensureThumbs(list) {
  let made = 0;
  for (const e of list.filter(b => b.cover && !b.thumb)) {
    try {
      const blob = await shrink(link(e.id, 'cover'));
      const r = await fetch(`${API}/books/${e.id}/thumb`,
        { method: 'PUT', headers: { ...head(), 'Content-Type': 'image/jpeg' }, body: await blob.arrayBuffer() });
      if (!r.ok) continue;
      e.thumb = (await r.json()).thumb;
      made++;
    } catch { /* обложка не открылась — полка обойдётся тем, что есть */ }
  }
  if (made) saveLib(list);
  return made;
}

export async function listBooks() {
  const r = await fetch(API + '/books', { headers: head() });
  if (!r.ok) throw new Error('список книг: ' + r.status);
  return r.json();
}

export async function uploadBook(file) {
  const body = new FormData();
  body.append('file', file, file.name || 'book.epub');
  const r = await fetch(API + '/books', { method: 'POST', headers: head(), body });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.detail || 'не вышло добавить книгу');
  }
  return r.json();
}

export async function deleteBook(id) {
  const r = await fetch(`${API}/books/${id}`, { method: 'DELETE', headers: head() });
  if (!r.ok) throw new Error('удаление: ' + r.status);
  return r.json();
}

/** Файл книги: сначала из своего кэша (мгновенно и офлайн), потом с сервера. */
export async function bookBytes(id) {
  const cached = await fileGet(id);
  if (cached) return cached.arrayBuffer ? await cached.arrayBuffer() : cached;
  const r = await fetch(`${API}/books/${id}/file`, { headers: head() });
  if (!r.ok) throw new Error('файл книги: ' + r.status);
  const buf = await r.arrayBuffer();
  filePut(id, buf).catch(() => {});     // не доехало в кэш — не повод не читать
  return buf;
}

/** Слить серверный список в локальный, сохранив прочитанное. */
export function mergeShelf(remote) {
  const known = new Map(lib().map(e => [e.id, e]));
  const list = remote.map(m => Object.assign({}, known.get(m.id), m));
  // Прогресс приезжает вместе со списком — полке больше ничего спрашивать не нужно.
  remote.forEach(m => applyPosition(m.id, m.position));
  saveLib(list);
  // Пропавшую с сервера книгу забываем вместе с её кэшем.
  known.forEach((e, id) => {
    if (!list.find(x => x.id === id)) ['pct:', 'pos:', 'hl:', 'loc:', 'chap:', 'at:'].forEach(p => ls.del(p + id));
  });
  return list;
}
