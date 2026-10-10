import { $ } from './core.js'
import { closeDrawer } from './drawers.js'
import { closeSheet } from './sheet.js'

/* ── Потянуть, чтобы закрыть ──
   Шторку тянут вниз за шапку, ящик на телефоне — вправо за что угодно. Панель едет за
   пальцем; отпустили дальше порога или бросили быстро — закрываем, иначе возвращаем. */

const FAR = 90;          // px: дальше — закрываем
const FAST = 0.55;       // px/мс: бросок закрывает и с короткого пути
const SLOP = 10;         // px: до этого жест ещё не решён (тап, прокрутка списка)

function dragClose(panel, { axis, from, close }) {
  let start = null, d = 0, locked = false, t0 = 0;

  const reset = () => { panel.style.transition = ''; panel.style.transform = ''; start = null; locked = false; d = 0; };

  panel.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || !panel.classList.contains('on')) return;
    // Кнопки и поля живут своей жизнью: тянуть ползунок или двигать курсор — не закрывать.
    if (e.target.closest('button, input, textarea, select, a')) return;
    if (from && !e.target.closest(from)) return;
    const p = e.touches[0];
    start = { x: p.clientX, y: p.clientY }; t0 = e.timeStamp; d = 0; locked = false;
  }, { passive: true });

  // Непассивный: когда жест наш, страница под панелью прокручиваться не должна.
  panel.addEventListener('touchmove', e => {
    if (!start) return;
    const p = e.touches[0];
    const dx = p.clientX - start.x, dy = p.clientY - start.y;
    const along = axis === 'x' ? dx : dy, across = axis === 'x' ? dy : dx;
    if (!locked) {
      if (Math.abs(along) < SLOP && Math.abs(across) < SLOP) return;
      // Пошли поперёк (прокрутка списка в ящике) или не в ту сторону — жест не наш.
      if (along <= 0 || Math.abs(along) < Math.abs(across) * 1.4) { start = null; return; }
      locked = true;
      panel.style.transition = 'none';
    }
    e.preventDefault();
    d = Math.max(0, along);
    panel.style.transform = axis === 'x' ? `translateX(${d}px)` : `translateY(${d}px)`;
  }, { passive: false });

  const end = e => {
    if (!start) return;
    const far = locked && e.type === 'touchend' && (d > FAR || d / Math.max(1, e.timeStamp - t0) > FAST);
    reset();                       // дальше панель ведёт CSS: с места, где её отпустили
    if (far) close();
  };
  panel.addEventListener('touchend', end, { passive: true });
  panel.addEventListener('touchcancel', end, { passive: true });
}

export function wireGestures() {
  dragClose($('#sheet'), { axis: 'y', from: '.grab, .sheet-head', close: closeSheet });
  dragClose($('#drawer'), { axis: 'x', close: closeDrawer });
}
