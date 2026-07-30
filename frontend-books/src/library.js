import { API, ls } from './core.js'
import { auth } from './auth.js'
import { fileGet, filePut, lib, saveLib } from './store.js'

/* ── Библиотека ──
   Книгами владеет сервер: список, файлы и обложки живут в корне books/. Локально
   держим только копию списка (полка рисуется сразу, ещё до ответа сервера) и сами файлы
   в IndexedDB — чтобы читать в самолёте. */

const head = () => ({ Authorization: 'Bearer ' + auth.token });

/** Обложка и файл открываются как обычные ссылки — токен в query, заголовок им не поставить. */
export const coverUrl = id => `${API}/books/${id}/cover?token=${encodeURIComponent(auth.token || '')}`;

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
  saveLib(list);
  // Пропавшую с сервера книгу забываем вместе с её кэшем.
  known.forEach((e, id) => {
    if (!list.find(x => x.id === id)) ['pct:', 'pos:', 'hl:', 'loc:', 'chap:', 'at:'].forEach(p => ls.del(p + id));
  });
  return list;
}
