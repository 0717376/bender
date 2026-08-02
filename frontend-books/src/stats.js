import { auth } from './auth.js'
import { API, $, el, escapeHtml, plural } from './core.js'

/* ── Статистика чтения ──
   Две половины: учёт (сколько минут книга была открыта и на сколько продвинулись) и
   экран с календарём. Учёт ведёт устройство: сервер не знает, лежит ли телефон
   экраном вниз. Считаем только видимое время — иначе «читал» превращается в
   «забыл закрыть вкладку». */

const BEAT = 60000;         // как часто отмечаемся
const MIN_SEND = 15;        // короче — не отправляем: это перелистнули и закрыли

const beat = { id: null, since: 0, secs: 0, pct: 0, seen: 0, timer: null, jump: false };

export const today = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function startReading(id, pct) {
  stopReading();
  beat.id = id; beat.since = Date.now(); beat.secs = 0; beat.pct = 0; beat.seen = pct || 0;
  beat.jump = false;
  beat.timer = setInterval(() => flush(false), BEAT);
}

/* Прыжок ползунком, поиском или оглавлением — не чтение. О нём читалка говорит заранее:
   угадывать по величине шага нельзя — в тонкой книге страница и есть несколько процентов. */
export function noteJump() { beat.jump = true; }

const WILD = 0.2;      // пятая часть книги за один переход — точно не перелистнули

/** Прочитанное за день — сумма движений вперёд: листание назад ничего не прибавляет. */
export function noteProgress(pct) {
  if (!beat.id) return;
  const step = pct - beat.seen;
  beat.seen = pct;
  if (beat.jump) { beat.jump = false; return; }
  if (step > 0 && step < WILD) beat.pct += step;
}

export function pauseReading() {
  if (!beat.id) return;
  collect();
  flush(true);
}

export function resumeReading() {
  if (beat.id) beat.since = Date.now();
}

export function stopReading() {
  clearInterval(beat.timer);
  if (beat.id) { collect(); flush(true); }
  beat.id = null; beat.timer = null; beat.since = 0;
}

function collect() {
  if (!beat.since) return;
  beat.secs += (Date.now() - beat.since) / 1000;
  beat.since = Date.now();
}

function flush(last) {
  if (!beat.id) return;
  if (!last) collect();
  const secs = Math.round(beat.secs);
  if ((secs < MIN_SEND && !beat.pct) || !auth.token) return;
  const body = JSON.stringify({ day: today(), secs, pct: beat.pct });
  const id = beat.id;
  beat.secs = 0; beat.pct = 0;
  fetch(`${API}/books/${id}/read`, {
    method: 'POST', keepalive: !!last,
    headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' },
    body,
  }).catch(() => {});      // не доехало — не беда, это статистика, а не выписки
}

/* ── Экран ── */

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const LEVELS = [0, 10, 30, 60];      // минуты: порог каждого следующего оттенка

const iso = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const hours = secs => {
  const m = Math.round(secs / 60);
  if (m < 60) return m + ' мин';
  return (m / 60).toFixed(m < 600 ? 1 : 0).replace('.', ',') + ' ч';
};
const human = day => {
  const d = parse(day);
  return d.getDate() + ' ' + MONTHS[d.getMonth()];
};

export async function openStats() {
  // Полку прячем: экраны лежат в одном потоке, иначе статистика встанет под ней.
  $('#shelf').classList.remove('on');
  $('#stats').classList.add('on');
  window.scrollTo(0, 0);
  const body = $('#statsBody');
  body.innerHTML = '<div class="empty">Считаю…</div>';
  let st;
  try {
    const tz = -new Date().getTimezoneOffset();
    const r = await fetch(`${API}/books/stats?tz=${tz}&today=${today()}&window=182`,
      { headers: { Authorization: 'Bearer ' + auth.token } });
    if (!r.ok) throw new Error(r.status);
    st = await r.json();
  } catch {
    body.innerHTML = '<div class="empty">Статистика не открылась.<br>Похоже, нет связи с сервером.</div>';
    return;
  }
  render(body, st);
}

export function closeStats() {
  $('#stats').classList.remove('on');
  $('#shelf').classList.add('on');
}

function render(body, st) {
  body.innerHTML = '';
  const t = st.totals;
  if (!t.days) {
    body.innerHTML = '<div class="empty">Пока нечего показывать.<br>'
      + 'Открой книгу — и через пару вечеров здесь будет календарь чтения.</div>';
    return;
  }

  body.appendChild(cards(t));
  const cal = calendar(st);
  body.appendChild(cal);
  cal.focusToday();                      // кольцо на сегодняшней клетке — уже в документе
  if (st.books.length) body.appendChild(byBook(st));
}

function cards(t) {
  const box = el('div', 'stat-cards');
  const card = (big, small, hint, icon) => {
    const c = el('div', 'stat-card');
    c.innerHTML = `<div class="big">${icon ? `<svg class="icon"><use href="#${icon}"/></svg>` : ''}${escapeHtml(big)}</div>
      <div class="lbl">${escapeHtml(small)}</div>${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ''}`;
    box.appendChild(c);
  };
  card(String(t.streak), plural(t.streak, 'день подряд', 'дня подряд', 'дней подряд').replace(/^\d+\s/, ''),
    t.best > t.streak ? `рекорд — ${t.best}` : 'это и есть рекорд', 'i-flame');
  card(hours(t.secs), 'за полгода', t.longest_day ? `лучший день — ${hours(t.longest_day)}` : '');
  card(String(t.days), plural(t.days, 'день с книгой', 'дня с книгой', 'дней с книгой').replace(/^\d+\s/, ''),
    t.secs && t.days ? `в среднем ${hours(t.secs / t.days)}` : '');
  return box;
}

/** Календарь: неделя — столбец, день — клетка, оттенок — по минутам. */
function calendar(st) {
  const wrap = el('div', 'cal-wrap');
  const head = el('div', 'cal-head');
  head.innerHTML = '<div class="h">Календарь</div><div class="cal-pick" id="calPick"></div>';
  wrap.appendChild(head);

  const byDay = new Map(st.days.map(d => [d.day, d]));
  const end = parse(st.today);
  const start = parse(st.from);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));      // отступаем до понедельника

  const scroll = el('div', 'cal-scroll');
  const grid = el('div', 'cal-grid');
  const months = el('div', 'cal-months');
  const days = el('div', 'cal-days');
  days.innerHTML = ['', 'Вт', '', 'Чт', '', 'Сб', ''].map(s => `<span>${s}</span>`).join('');

  let col = null, lastMonth = -1, cells = 0;
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (!col || cells % 7 === 0) {
      col = el('div', 'cal-col');
      grid.appendChild(col);
      const label = el('span', 'cal-month');
      // Подпись месяца — над первой его неделей, иначе строка превращается в кашу.
      if (d.getMonth() !== lastMonth && d.getDate() <= 7) { label.textContent = MONTHS[d.getMonth()]; lastMonth = d.getMonth(); }
      months.appendChild(label);
    }
    const day = iso(d);
    const info = byDay.get(day);
    const mins = info ? info.secs / 60 : 0;
    const lvl = LEVELS.filter(x => mins > x).length;
    const cell = el('button', 'cell l' + lvl);
    cell.dataset.day = day;
    cell.title = `${human(day)} — ${info ? hours(info.secs) : 'не читали'}`;
    cell.onclick = () => pick(day, info);
    col.appendChild(cell);
    cells++;
  }
  scroll.appendChild(months);
  scroll.appendChild(grid);
  const row = el('div', 'cal-row');
  row.appendChild(days);
  row.appendChild(scroll);
  wrap.appendChild(row);

  const legend = el('div', 'cal-legend');
  legend.innerHTML = '<span>меньше' + [0, 1, 2, 3, 4].map(l => `<i class="cell l${l}"></i>`).join('') + 'больше</span>';
  wrap.appendChild(legend);

  // Свежая неделя справа: календарь смотрят с конца.
  setTimeout(() => { scroll.scrollLeft = scroll.scrollWidth; }, 0);
  wrap.focusToday = () => pick(st.today, byDay.get(st.today));
  return wrap;
}

function pick(day, info, root) {
  const box = (root || document).querySelector('#calPick');
  if (!box) return;
  const parts = [human(day)];
  if (info && info.secs) parts.push(hours(info.secs));
  if (info && info.pct >= 0.005) parts.push(Math.round(info.pct * 100) + '% книги');
  box.textContent = parts.length > 1 ? parts.join(' · ') : parts[0] + ' — не читали';
  document.querySelectorAll('#statsBody .cell[data-day]').forEach(c =>
    c.classList.toggle('on', c.dataset.day === day));
}

function byBook(st) {
  const box = el('div', 'stat-books');
  box.appendChild(el('div', 'h', 'По книгам'));
  const most = Math.max(...st.books.map(b => b.secs), 1);
  st.books.forEach(b => {
    const row = el('div', 'stat-book');
    const bits = [b.secs ? hours(b.secs) : 'без учёта времени'];
    if (b.at) bits.push('прочитано ' + Math.round(b.at * 100) + '%');
    row.innerHTML = `<div class="t">${escapeHtml(b.title)}</div>
      <div class="lane"><i style="width:${Math.max(2, Math.round(b.secs / most * 100))}%"></i></div>
      <div class="m">${escapeHtml(bits.join(' · '))}</div>`;
    box.appendChild(row);
  });
  return box;
}

/* Читалка сама не знает про статистику — связывает их main.js, но прогресс приходит
   из читалки, поэтому оставляем один вход. */
export function wireReadingBeat() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pauseReading();
    else resumeReading();
  });
  window.addEventListener('pagehide', pauseReading);
  window.addEventListener('beforeunload', pauseReading);
}
