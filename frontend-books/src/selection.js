import { $, el, state } from './core.js'
import { hideSelbar, showSelbar } from './highlights.js'
import { live } from './sync.js'

/* ── Своё выделение ──
   iOS показывает своё меню над любым выделением, которое сделал пользователь, и убрать его
   нечем. Поэтому браузер у нас не выделяет вовсе (user-select: none): по долгому нажатию мы
   сами находим слово, сами красим строки и сами тянем края за маркеры.

   Движков два, а жест один. Механика ниже не знает ни про cfi, ни про страницы: она держит
   две точки и просит поверхность посчитать между ними отрезок. Поверхность — это глава epub
   в iframe или текстовый слой поверх страницы pdf, и что такое «точка», решает она сама:
   в epub это каретка, в pdf — строка и символ в ней. */

export const LONGPRESS_MS = 330;
export const sel = { on: false, surf: null, anchor: null, focus: null, drag: null, justEnded: false, dismissed: false };

export function caretAt(doc, x, y) {
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  const p = doc.caretPositionFromPoint && doc.caretPositionFromPoint(x, y);
  if (!p) return null;
  const r = doc.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true);
  return r;
}

export const WORD = /[\p{L}\p{N}'’\-]/u;

export function wordAt(doc, x, y) {
  const caret = caretAt(doc, x, y);
  if (!caret || caret.startContainer.nodeType !== 3) return null;
  return wordAround(caret.startContainer.textContent, caret.startOffset, (a, b) => {
    const r = doc.createRange();
    r.setStart(caret.startContainer, a); r.setEnd(caret.startContainer, b);
    return r;
  });
}

/** Границы слова вокруг позиции — общее для обоих движков. */
export function wordAround(text, at, make) {
  let a = at, b = at;
  while (a > 0 && WORD.test(text[a - 1])) a--;
  while (b < text.length && WORD.test(text[b])) b++;
  if (a === b) { a = Math.max(0, a - 1); b = Math.min(text.length, b + 1); }
  return make(a, b);
}

/** Отрезок между точками: прямоугольники, текст и якорь. Порядок точек поверхность знает сама. */
export function selSpan() {
  if (!sel.anchor || !sel.focus || !sel.surf) return null;
  try { return sel.surf.span(sel.anchor, sel.focus); } catch { return null; }
}

/* Маркеры живут постоянно и только переставляются: пересоздавать их на каждое движение
   нельзя — тот, за который тянут, исчезнет из-под пальца вместе с захватом указателя. */
export const handles = {};

export function makeHandle(kind) {
  const d = el('div', 'handle ' + kind);
  d.style.display = 'none';
  d.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    const s = selSpan();
    if (!s) return;
    sel.drag = kind;
    sel.anchor = kind === 'start' ? s.to : s.from;   // тянем один край — второй становится якорем
    d.setPointerCapture(e.pointerId);
    hideSelbar();
  });
  d.addEventListener('pointermove', e => {
    if (sel.drag !== kind) return;
    e.preventDefault();
    const fr = sel.surf.origin();
    // Целимся мимо пальца: иначе он закрывает ровно ту строку, которую тянешь.
    const dy = kind === 'end' ? -12 : 12;
    const p = sel.surf.at(e.clientX - fr.left, e.clientY - fr.top + dy);
    if (!p) return;
    const was = sel.focus;
    sel.focus = p;
    if (selSpan()) paintSel(); else sel.focus = was;
  });
  const done = () => { if (sel.drag === kind) { sel.drag = null; commitSel(); } };
  d.addEventListener('pointerup', done);
  d.addEventListener('pointercancel', done);
  $('#selLayer').appendChild(d);
  return d;
}

export function placeHandle(kind, x, y, h) {
  const d = handles[kind] || (handles[kind] = makeHandle(kind));
  d.style.display = '';
  d.style.left = x + 'px'; d.style.top = y + 'px'; d.style.height = h + 'px';
}

/* Полосы выделения переиспользуются, а не пересоздаются: снести и заново вставить их на
   каждое движение пальца — значит показать между кадрами пустую страницу, отчего выделение
   и мигало. Заодно перерисовка сводится к одной на кадр: пальцу браузер шлёт события чаще. */
const rects = [];
let painting = false;

export function paintSel() {
  if (painting) return;
  painting = true;
  requestAnimationFrame(() => { painting = false; paintNow(); });
}

function paintNow() {
  const s = sel.on ? selSpan() : null;
  const list = (s && s.rects) || [];
  if (!list.length) {
    rects.forEach(d => { d.style.display = 'none'; });
    Object.values(handles).forEach(h => { h.style.display = 'none'; });
    return;
  }
  const layer = $('#selLayer'), fr = sel.surf.origin();
  list.forEach((r, i) => {
    let d = rects[i];
    if (!d) { d = rects[i] = el('div', 'selrect'); layer.insertBefore(d, layer.firstChild); }
    d.style.display = '';
    d.style.cssText = `left:${fr.left + r.left}px; top:${fr.top + r.top}px; width:${r.width}px; height:${r.height}px`;
  });
  for (let i = list.length; i < rects.length; i++) rects[i].style.display = 'none';
  const first = list[0], last = list[list.length - 1];
  placeHandle('start', fr.left + first.left, fr.top + first.top, first.height);
  placeHandle('end', fr.left + last.right, fr.top + last.top, last.height);
}

export function wireSelection(surf) {
  const doc = surf.doc, root = surf.root || doc;
  let timer = null, sx = 0, sy = 0, pressing = false;

  root.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Нажатие по тексту снимает прошлое выделение сразу, а не по отпусканию:
    // иначе обычный клик мимо заново коммитил бы старый диапазон.
    sel.dismissed = false;
    if (sel.on) { clearSel(); sel.dismissed = true; }
    sx = e.clientX; sy = e.clientY; pressing = true;
    // Забираем указатель себе: iOS иначе на полпути объявляет жест прокруткой и шлёт
    // pointercancel — выделение обрывается посреди движения.
    if (root.setPointerCapture) { try { root.setPointerCapture(e.pointerId); } catch {} }
    clearTimeout(timer);
    const begin = () => {
      const w = surf.word(sx, sy);
      if (!w) return;
      sel.on = true; sel.surf = surf; sel.anchor = w[0]; sel.focus = w[1];
      hideSelbar(); paintSel();
    };
    // Мышь выделяет сразу протаскиванием, палец — только после удержания:
    // иначе любой свайп по странице превращался бы в выделение.
    timer = e.pointerType === 'mouse' ? null : setTimeout(begin, LONGPRESS_MS);
    if (e.pointerType === 'mouse') sel.pendingMouse = { x: sx, y: sy };
  }, { passive: true });

  // Двигать и отпускать палец могут уже мимо страницы — за полем, по полосам, по краю
  // экрана. Поэтому слушаем документ, а не только саму страницу: иначе выделение
  // застывает на полпути, а отпускание за краем оставляет его висеть.
  doc.addEventListener('pointermove', e => {
    if (!pressing) return;
    if (sel.pendingMouse && !sel.on && Math.hypot(e.clientX - sx, e.clientY - sy) > 4) {
      const w = surf.word(sel.pendingMouse.x, sel.pendingMouse.y);
      if (w) { sel.on = true; sel.surf = surf; sel.anchor = w[0]; sel.focus = w[1]; }
    }
    if (!sel.on) {
      // Палец дрожит всегда; 14px — это уже осознанный свайп, а не удержание.
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 14) clearTimeout(timer);
      return;
    }
    e.preventDefault();                       // держим страницу на месте, пока тянем
    const p = surf.at(e.clientX, e.clientY);  // событие из документа поверхности — координаты её
    if (!p) return;
    // Край, от которого отрезок схлопывается (палец левее начала строки, мимо текста),
    // не принимаем: выделение должно стоять на месте, а не пропадать и появляться.
    const was = sel.focus;
    sel.focus = p;
    if (selSpan()) paintSel(); else sel.focus = was;
  }, { passive: false });

  // Только своё отпускание: слушаем весь документ, и без этой проверки палец, снятый
  // с кнопки панели, пересобирал бы панель — кнопку сносит из DOM раньше, чем долетит клик.
  const finish = () => {
    if (!pressing) return;
    pressing = false; sel.pendingMouse = null; clearTimeout(timer);
    if (sel.on) { sel.justEnded = true; commitSel(); }
  };
  doc.addEventListener('pointerup', finish);
  doc.addEventListener('pointercancel', finish);
}

export function commitSel() {
  const s = selSpan();
  if (!s) return clearSel();
  const text = (s.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return clearSel();
  let cfi = null;
  try { cfi = s.id(); } catch (e) { console.warn('anchor failed', e); }
  if (!cfi) return clearSel();
  const known = live().find(h => h.cfi === cfi);
  state.pending = known || {
    id: 'h' + Date.now().toString(36), cfi, text,
    chapter: sel.surf.chapter() || '',
    color: null, thread: [], ts: Date.now(),
  };
  paintSel();
  const fr = sel.surf.origin(), list = s.rects;
  const first = list[0], last = list[list.length - 1];
  showSelbar(first && {
    top: fr.top + first.top, bottom: fr.top + last.bottom,
    left: fr.left + Math.min(...list.map(r => r.left)),
    right: fr.left + Math.max(...list.map(r => r.right)),
  });
}

export function clearSel() {
  sel.on = false; sel.anchor = sel.focus = null; sel.drag = null;
  // Полосы и маркеры не удаляем, а прячем: они переиспользуются, а удаление узлов
  // оставило бы в handles ссылки на выброшенные из документа элементы.
  rects.forEach(d => { d.style.display = 'none'; });
  Object.values(handles).forEach(h => { h.style.display = 'none'; });
  hideSelbar();
}

/** Запасной путь: если браузер всё же сам что-то выделил. */
export async function onSelected() {
  if (sel.on) return;
  try { state.rendition.getContents().forEach(c => c.window.getSelection().removeAllRanges()); } catch {}
}
