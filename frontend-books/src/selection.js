import { $, el, state } from './core.js'
import { hideSelbar, showSelbar } from './highlights.js'
import { live } from './sync.js'

/* ── Своё выделение ──
   iOS показывает своё меню над любым выделением, которое сделал пользователь, и убрать его
   нечем. Поэтому браузер у нас не выделяет вовсе (user-select: none): по долгому нажатию мы
   сами находим слово, сами красим строки и сами тянем края за маркеры.

   Движков два, а жест один: механика ниже работает с «поверхностью» — это epub-глава
   в iframe или текстовый слой поверх страницы pdf. Поверхность знает три вещи:
   где её документ лежит в окне, как назвать выделенное место (cfi или 'pdf:стр:от-до')
   и в какой оно главе. Всё остальное — общее. */

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
  const text = caret.startContainer.textContent;
  let a = caret.startOffset, b = caret.startOffset;
  while (a > 0 && WORD.test(text[a - 1])) a--;
  while (b < text.length && WORD.test(text[b])) b++;
  if (a === b) { a = Math.max(0, a - 1); b = Math.min(text.length, b + 1); }
  const r = doc.createRange();
  r.setStart(caret.startContainer, a); r.setEnd(caret.startContainer, b);
  return r;
}

/** Диапазон от якоря к текущему краю — в правильном порядке, за какой бы маркер ни тянули. */
export function selRange() {
  if (!sel.anchor || !sel.focus || !sel.surf) return null;
  const doc = sel.surf.doc;
  const r = doc.createRange();
  const back = sel.anchor.compareBoundaryPoints(Range.START_TO_START, sel.focus) > 0;
  const [from, to] = back ? [sel.focus, sel.anchor] : [sel.anchor, sel.focus];
  r.setStart(from.startContainer, from.startOffset);
  r.setEnd(to.endContainer, to.endOffset);
  return r.collapsed ? null : r;
}

/* Маркеры живут постоянно и только переставляются: пересоздавать их на каждое движение
   нельзя — тот, за который тянут, исчезнет из-под пальца вместе с захватом указателя. */
export const handles = {};

export function makeHandle(kind) {
  const d = el('div', 'handle ' + kind);
  d.style.display = 'none';
  d.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    const range = selRange();
    if (!range) return;
    sel.drag = kind;
    // Тянем один край — второй становится якорем.
    const other = sel.surf.doc.createRange();
    if (kind === 'start') other.setStart(range.endContainer, range.endOffset);
    else other.setStart(range.startContainer, range.startOffset);
    other.collapse(true);
    sel.anchor = other;
    d.setPointerCapture(e.pointerId);
    hideSelbar();
  });
  d.addEventListener('pointermove', e => {
    if (sel.drag !== kind) return;
    e.preventDefault();
    const fr = sel.surf.origin();
    // Целимся мимо пальца: иначе он закрывает ровно ту строку, которую тянешь.
    const dy = kind === 'end' ? -12 : 12;
    const caret = caretAt(sel.surf.doc, e.clientX - fr.left, e.clientY - fr.top + dy);
    if (caret) { sel.focus = caret; paintSel(); }
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

export function paintSel() {
  const layer = $('#selLayer');
  [...layer.querySelectorAll('.selrect')].forEach(n => n.remove());
  const range = selRange();
  const rects = range ? [...range.getClientRects()].filter(r => r.width > 0.5 && r.height > 0.5) : [];
  if (!rects.length) {
    Object.values(handles).forEach(h => { h.style.display = 'none'; });
    return;
  }
  const fr = sel.surf.origin();
  rects.forEach(r => {
    const d = el('div', 'selrect');
    d.style.cssText = `left:${fr.left + r.left}px; top:${fr.top + r.top}px; width:${r.width}px; height:${r.height}px`;
    layer.insertBefore(d, layer.firstChild);
  });
  const first = rects[0], last = rects[rects.length - 1];
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
    clearTimeout(timer);
    const begin = () => {
      const r = wordAt(doc, sx, sy);
      if (!r) return;
      sel.on = true; sel.surf = surf; sel.anchor = r; sel.focus = r;
      hideSelbar(); paintSel();
    };
    // Мышь выделяет сразу протаскиванием, палец — только после удержания:
    // иначе любой свайп по странице превращался бы в выделение.
    timer = e.pointerType === 'mouse' ? null : setTimeout(begin, LONGPRESS_MS);
    if (e.pointerType === 'mouse') sel.pendingMouse = { x: sx, y: sy };
  }, { passive: true });

  root.addEventListener('pointermove', e => {
    if (!pressing) return;
    if (sel.pendingMouse && !sel.on && Math.hypot(e.clientX - sx, e.clientY - sy) > 4) {
      const r = wordAt(doc, sel.pendingMouse.x, sel.pendingMouse.y);
      if (r) { sel.on = true; sel.surf = surf; sel.anchor = r; sel.focus = r; }
    }
    if (!sel.on) {
      // Палец дрожит всегда; 14px — это уже осознанный свайп, а не удержание.
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 14) clearTimeout(timer);
      return;
    }
    e.preventDefault();                       // держим страницу на месте, пока тянем
    const caret = caretAt(doc, e.clientX, e.clientY);
    if (caret) { sel.focus = caret; paintSel(); }
  }, { passive: false });

  const finish = () => {
    pressing = false; sel.pendingMouse = null; clearTimeout(timer);
    if (sel.on) { sel.justEnded = true; commitSel(); }
  };
  root.addEventListener('pointerup', finish);
  root.addEventListener('pointercancel', finish);
}

export function commitSel() {
  const range = selRange();
  if (!range) return clearSel();
  const text = range.toString().replace(/\s+/g, ' ').trim();
  if (!text) return clearSel();
  let cfi = null;
  try { cfi = sel.surf.anchor(range); } catch (e) { console.warn('anchor failed', e); }
  if (!cfi) return clearSel();
  const known = live().find(h => h.cfi === cfi);
  state.pending = known || {
    id: 'h' + Date.now().toString(36), cfi, text,
    chapter: sel.surf.chapter() || '',
    color: null, thread: [], ts: Date.now(),
  };
  paintSel();
  const rects = [...range.getClientRects()].filter(r => r.width > 0.5);
  const fr = sel.surf.origin();
  const first = rects[0], last = rects[rects.length - 1];
  showSelbar(first && {
    top: fr.top + first.top, bottom: fr.top + last.bottom,
    left: fr.left + Math.min(...rects.map(r => r.left)),
    right: fr.left + Math.max(...rects.map(r => r.right)),
  });
}

export function clearSel() {
  sel.on = false; sel.anchor = sel.focus = null; sel.drag = null;
  // Маркеры не удаляем, а прячем: они переиспользуются, а innerHTML = '' оставил бы
  // в handles ссылки на выброшенные из документа узлы — и следующее выделение осталось бы без них.
  [...$('#selLayer').querySelectorAll('.selrect')].forEach(n => n.remove());
  Object.values(handles).forEach(h => { h.style.display = 'none'; });
  hideSelbar();
}

/** Запасной путь: если браузер всё же сам что-то выделил. */
export async function onSelected(cfiRange) {
  if (sel.on) return;
  try { state.rendition.getContents().forEach(c => c.window.getSelection().removeAllRanges()); } catch {}
}
