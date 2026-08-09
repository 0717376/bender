import { $, COLORS, colorOf, el, ls, state, toast } from './core.js'
import { clearSel, sel } from './selection.js'
import { askAgent } from './sheet.js'
import { live, markDirty, sync } from './sync.js'

/* ── Панель над выделением ── */

export const ACTS = [
  { kind: 'translate', label: 'Перевести', icon: 'i-lang' },
  { kind: 'explain', label: 'Объяснить', icon: 'i-bulb' },
  { kind: 'ask', label: 'Спросить', icon: 'i-ask' },
];

export function showSelbar(rect) {
  const bar = $('#selbar');
  bar.classList.add('on');
  const colors = $('#selColors'), acts = $('#selActs');
  colors.innerHTML = ''; acts.innerHTML = '';
  const cur = (state.pending || {}).color;
  COLORS.forEach(c => {
    const d = el('button', 'dot' + (c.id === cur ? ' sel' : '')); d.style.background = c.hex; d.title = c.name;
    d.onclick = () => paint(c.id);
    colors.appendChild(d);
  });
  const copy = el('button', 'tb');
  copy.innerHTML = '<svg class="icon"><use href="#i-copy"/></svg>';
  copy.onclick = () => {
    const t = (state.pending || {}).text || '';
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
      () => toast('Скопировано'), () => toast('Скопировать не вышло'));
    clearSel();
  };
  colors.appendChild(copy);

  ACTS.forEach((a, i) => {
    const b = el('button', 'act' + (i === 0 ? ' primary' : ''));
    b.innerHTML = `<svg class="icon"><use href="#${a.icon}"/></svg>${a.label}`;
    b.onclick = () => askAgent(a.kind);
    acts.appendChild(b);
  });

  bar.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let top, left;
    if (rect) {
      top = rect.top - bh - 14;
      left = (rect.left + rect.right) / 2 - bw / 2;
      // Не влезло сверху — уводим под выделение, но не на маркер.
      if (top < 8) top = rect.bottom + 18;
    } else {
      top = window.innerHeight - bh - 90; left = (window.innerWidth - bw) / 2;
    }
    bar.style.top = Math.max(8, Math.min(top, window.innerHeight - bh - 8)) + 'px';
    bar.style.left = Math.max(8, Math.min(left, window.innerWidth - bw - 8)) + 'px';
    bar.style.visibility = '';
  });
}

export function hideSelbar() { $('#selbar').classList.remove('on'); }

export function paint(colorId) {
  const h = state.pending;
  if (!h) return;
  const exists = live().find(x => x.cfi === h.cfi);
  if (exists) {
    exists.color = colorId; touch(exists);
    eraseHighlight(exists);
    drawHighlight(exists);
  } else {
    h.color = colorId; touch(h);
    state.hl.push(h);
    drawHighlight(h);
  }
  save();
  clearSel();
  toast(colorOf(colorId).name);
}

/* Метки epub рисует сам движок по cfi, в pdf их кладём мы поверх страницы — но зовётся
   это одинаково: кто рисует, решает вид книги, а не тот, кто сохранил выписку. */
export function drawHighlight(h) {
  if (state.kind === 'pdf') { if (state.pdf) state.pdf.redraw(); return; }
  try {
    state.rendition.annotations.highlight(h.cfi, { id: h.id }, () => {}, 'hl-' + h.color,
      { fill: colorOf(h.color).hex, 'fill-opacity': '.32' });
  } catch (e) { console.warn('highlight failed', h.cfi, e); }
}

export function eraseHighlight(h) {
  if (state.kind === 'pdf') return;      // метки pdf перерисовываются целиком, стирать нечего
  try { state.rendition.annotations.remove(h.cfi, 'highlight'); } catch {}
}

/* Смена кегля перекладывает текст, но не пересоздаёт страницы — и нарисованные
   прямоугольники остаются от старой раскладки. Пересоздаём метки по живым выпискам. */
export function redrawHighlights() {
  if (state.kind === 'pdf') { if (state.pdf) state.pdf.redraw(); return; }
  if (!state.rendition) return;
  live().forEach(eraseHighlight);
  live().forEach(drawHighlight);
}

export function save() {
  if (!state.entry) return;      // книгу закрыли, пока дописывалась заметка
  const now = Date.now();
  state.hl.forEach(h => { if (!h.upd) h.upd = h.ts || now; });
  ls.set('hl:' + state.entry.id, state.hl);
  ls.set('at:' + state.entry.id, now);
  markDirty(state.entry.id);
  sync.later(2000);
}
export function touch(h) { h.upd = Date.now(); }
