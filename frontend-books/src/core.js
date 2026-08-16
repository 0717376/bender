'use strict';

import { locale, plural, t } from './i18n.js'

/* Книги — читалка epub с агентом.
   Бэкенд один на все приложения: авторизация и чат живут на вики. */
/* Бэкенд — тот же, что у вики и задач: nginx приложения проксирует /auth, /books и /chat
   на него же, поэтому обращаемся по своему адресу и без CORS. */
export const API = '';

/* Цвет = смысл, а не украшение: по нему потом фильтруют выписки. Имя цвета —
   ключ в словаре: смысл один, а слово зависит от языка интерфейса. */
export const COLORS = [
  { id: 'imp',  hex: '#F5C64A', key: 'colorImp' },
  { id: 'no',   hex: '#E4707A', key: 'colorNo' },
  { id: 'q',    hex: '#6FA8FF', key: 'colorQ' },
  { id: 'wiki', hex: '#7DBE8A', key: 'colorWiki' },
  { id: 'nice', hex: '#A98FE3', key: 'colorNice' },
];
export const colorOf = id => (COLORS.find(c => c.id === id) || COLORS[0]);
export const colorName = id => t(colorOf(id).key);

export const $ = s => document.querySelector(s);
export const el = (t, cls, html) => { const n = document.createElement(t); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
export const ls = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} },
};
export const escapeHtml = s => { const d = el('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
export function when(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return t('justNow');
  if (s < 5400) return t('ago', plural(Math.round(s / 60), 'minutesAgo'));
  if (s < 86400) return t('ago', plural(Math.round(s / 3600), 'hoursAgo'));
  return new Date(ts).toLocaleDateString(locale);
}

export let toastT;
export function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200);
}

export const state = {
  book: null, rendition: null, entry: null, meta: null,
  kind: '',            // чем открыта книга: 'epub' | 'pdf'
  pdf: null,           // состояние pdf-движка (см. pdfview.js)
  hl: [],              // выписки: {id, cfi, text, color, chapter, thread, ts}
  pending: null,       // выделение до того, как его закрасили
  active: null,        // выписка, открытая в шторке
  fontSize: ls.get('set:font', 108),
  margin: ls.get('set:margin', 'normal'),
  flow: ls.get('set:flow', 'paginated'),
  spread: ls.get('set:spread', 'auto'),
  theme: ls.get('set:theme', 'auto'),
  thread: [],
};
