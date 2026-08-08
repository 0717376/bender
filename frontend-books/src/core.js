'use strict';

/* Книги — читалка epub с агентом.
   Бэкенд один на все приложения: авторизация и чат живут на вики. */
/* Бэкенд — тот же, что у вики и задач: nginx приложения проксирует /auth, /books и /chat
   на него же, поэтому обращаемся по своему адресу и без CORS. */
export const API = '';

/* Цвет = смысл, а не украшение: по нему потом фильтруют выписки. */
export const COLORS = [
  { id: 'imp',  hex: '#F5C64A', name: 'Важное' },
  { id: 'no',   hex: '#E4707A', name: 'Не согласен' },
  { id: 'q',    hex: '#6FA8FF', name: 'Вопрос' },
  { id: 'wiki', hex: '#7DBE8A', name: 'В вики' },
  { id: 'nice', hex: '#A98FE3', name: 'Красиво сказано' },
];
export const colorOf = id => (COLORS.find(c => c.id === id) || COLORS[0]);

export const $ = s => document.querySelector(s);
export const el = (t, cls, html) => { const n = document.createElement(t); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
export const ls = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} },
};
export const escapeHtml = s => { const d = el('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
export const plural = (n, a, b, c) => { const m = n % 100, k = n % 10;
  return n + ' ' + (m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c); };
export function when(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return 'только что';
  if (s < 5400) return plural(Math.round(s / 60), 'минуту', 'минуты', 'минут') + ' назад';
  if (s < 86400) return plural(Math.round(s / 3600), 'час', 'часа', 'часов') + ' назад';
  return new Date(ts).toLocaleDateString('ru-RU');
}

export let toastT;
export function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200);
}

export const state = {
  book: null, rendition: null, entry: null, meta: null,
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
