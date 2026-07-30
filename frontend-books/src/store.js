import { ls } from './core.js'

/* ── Хранилище книг ──
   Индекс полки лежит в localStorage (рисуется мгновенно), сами файлы — в IndexedDB. */

export const LIB = 'library';
export const lib = () => ls.get(LIB, []);
export const saveLib = list => ls.set(LIB, list);

export let dbP = null;
export function db() {
  if (dbP) return dbP;
  dbP = new Promise((res, rej) => {
    const r = indexedDB.open('reader', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('files')) r.result.createObjectStore('files'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbP;
}
export async function fileGet(id) {
  const d = await db();
  return new Promise((res, rej) => {
    const q = d.transaction('files').objectStore('files').get(id);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
/* Кладём ArrayBuffer, а не File: WebKit отказывается складывать Blob в IndexedDB
   («Error preparing Blob/File data to be stored»), и книга не доезжает до полки. */
export async function filePut(id, buf) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('files', 'readwrite');
    tx.objectStore('files').put(buf, id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
export async function fileDel(id) {
  const d = await db();
  return new Promise(res => {
    const tx = d.transaction('files', 'readwrite');
    tx.objectStore('files').delete(id); tx.oncomplete = res; tx.onerror = res;
  });
}
