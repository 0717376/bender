import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { agent } from './agent.js'
import { auth, showAuth } from './auth.js'
import { $, colorOf, el, API, ls, state, toast } from './core.js'
import { bookBytes } from './library.js'
import { scrubbing, syncChrome } from './reader.js'
import { clearSel, sel, wireSelection } from './selection.js'
import { openHighlight } from './sheet.js'
import { hideMenu } from './shelf.js'
import { lib, saveLib } from './store.js'
import { live, markDirty, sync } from './sync.js'
import { noteJump, noteProgress, startReading } from './stats.js'

/* ── PDF ──
   Второй движок рядом с epub.js: страница рисуется канвасом, «раскладки» нет — PDF
   свёрстан навсегда, читалка только подгоняет страницу под окно и листает. Модуль
   грузится лениво из openBook: кто читает epub, pdf.js не качает. */

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export async function openPdf(entry) {
  $('#splash').classList.remove('off');
  $('#splash').textContent = 'открываю книгу…';
  hideMenu();
  $('#scrub').disabled = true; $('#scrub').value = 0;
  wireViewer();
  try {
    // Позиция с другого устройства нужна до показа страницы, но ждать сервер бесконечно нельзя.
    await Promise.race([sync.pull(entry.id).catch(() => false), new Promise(r => setTimeout(r, 3500))]);
    const doc = await pdfjs.getDocument({ data: await bookBytes(entry.id) }).promise;
    state.entry = entry;
    state.kind = 'pdf';
    state.hl = ls.get('hl:' + entry.id, []);
    state.pdf = { doc, pages: doc.numPages, page: 0, outline: [], text: {}, task: null,
                  wrap: null, canvas: null, layer: null, marks: null,
                  prev, next, goto, refit, search, labelAt: chapterAt,
                  redraw: drawMarks, hlAt: markAt, context };

    entry.opened = Date.now();
    saveLib(lib().map(x => x.id === entry.id ? entry : x));

    $('#bookTitle').textContent = entry.title || '';
    $('#shelf').classList.remove('on');
    $('#reader').classList.add('on'); $('#reader').classList.add('pdf');
    $('#viewer').classList.remove('spread');
    document.documentElement.classList.add('reading');
    syncChrome();

    state.pdf.outline = await loadOutline(doc);
    await show(savedPage(entry.id, doc.numPages));
    $('#splash').classList.add('off');
    $('#scrub').disabled = false;        // страницы известны сразу — локации считать нечего
    startReading(entry.id, ls.get('pct:' + entry.id, 0));
    ensureThumb(entry, doc).catch(() => {});
    if (auth.token) agent.connect().catch(() => {});   // прогреваем связь, пока читается страница
  } catch (e) {
    console.warn(e);
    $('#splash').classList.add('off');
    if (/\b401\b/.test(e.message || '')) { auth.forget(); showAuth('Сессия истекла, войди заново'); }
    else toast('Книга не открылась');
  }
}

/** Позиция pdf — просто страница: 'pdf:12'. Синхронизации всё равно, что внутри строки. */
function savedPage(id, pages) {
  const m = /^pdf:(\d+)$/.exec(ls.get('pos:' + id, '') || '');
  return Math.max(1, Math.min(pages, m ? +m[1] : 1));
}

function prev() { if (state.pdf && state.pdf.page > 1) show(state.pdf.page - 1); }
function next() { if (state.pdf && state.pdf.page < state.pdf.pages) show(state.pdf.page + 1); }
function goto(page) { noteJump(); return show(page); }
function refit() { if (state.pdf && state.pdf.page) render(); }

async function show(n) {
  const v = state.pdf;
  if (!v) return;
  const to = Math.max(1, Math.min(v.pages, n));
  if (to !== v.page) clearSel();
  v.page = to;
  await render();
  if (state.pdf === v) onPage();
}

/** Канвас, текстовый слой и метки выписок — тремя слоями в общей обёртке по размеру страницы. */
function mount(v) {
  if (v.wrap) return;
  v.wrap = el('div', 'pdfwrap');
  v.canvas = document.createElement('canvas');
  v.canvas.className = 'pdfpage';
  v.marks = el('div', 'pdfhl');
  v.layer = el('div', 'textLayer');
  v.wrap.append(v.canvas, v.marks, v.layer);
  $('#viewer').innerHTML = '';
  $('#viewer').appendChild(v.wrap);
  // Поверхность выделения одна на книгу: слой пересоздаётся каждой страницей,
  // а обёртка живёт, пока книга открыта — на ней и держим слушателей.
  v.surf = surface(v);
  wireSelection(v.surf);
}

/** Страница целиком в окно, без прокрутки — как разворот бумажной книги на столе. */
async function render() {
  const v = state.pdf;
  const page = await v.doc.getPage(v.page);
  // Прошлый рендер не просто отменяем — дожидаемся отмены: тот же канвас двум
  // задачам pdf.js отдавать нельзя, он на этом падает.
  if (v.task) { try { v.task.cancel(); } catch {} try { await v.task.promise; } catch {} v.task = null; }
  if (state.pdf !== v || page.pageNumber !== v.page) return;   // пока грузили — ушли дальше
  const box = $('#viewer').getBoundingClientRect();
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(box.width / base.width, box.height / base.height) || 1;
  // Рисуем в физические пиксели: канвас в css-размере на ретине — мыло.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const css = page.getViewport({ scale });
  const vp = page.getViewport({ scale: scale * dpr });
  mount(v);
  const c = v.canvas;
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const w = Math.floor(css.width), h = Math.floor(css.height);
  v.wrap.style.width = w + 'px'; v.wrap.style.height = h + 'px';
  c.style.width = w + 'px'; c.style.height = h + 'px';
  const ctx = c.getContext('2d');
  // Свой белый фон: страница без явной заливки в jpeg и тёмной теме станет чёрной.
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  v.task = page.render({ canvasContext: ctx, viewport: vp });
  try { await v.task.promise; } catch { /* отменили ради следующей страницы */ }
  v.task = null;
  await renderText(v, page, css);
}

/* ── Текстовый слой ──
   Канвас — картинка, выделять на нём нечего. pdf.js кладёт поверх прозрачные строки
   ровно по глифам: браузер по ним считает каретку, а мы поверх рисуем своё выделение
   и метки выписок. Слой пересобирается на каждую страницу и каждую подгонку размера. */

async function renderText(v, page, css) {
  if (v.tl) { try { v.tl.cancel(); } catch {} v.tl = null; }
  v.layer.innerHTML = '';
  // Строки позиционируются в долях страницы — масштаб слою передаётся переменной.
  v.layer.style.setProperty('--total-scale-factor', css.scale);
  const tl = v.tl = new pdfjs.TextLayer({
    textContentSource: page.streamTextContent(), container: v.layer, viewport: css,
  });
  try { await tl.render(); } catch { /* ушли на другую страницу */ }
  if (state.pdf !== v || v.page !== page.pageNumber) return;
  drawMarks();
}

function onPage() {
  const v = state.pdf, id = state.entry.id;
  const pos = 'pdf:' + v.page;
  const pct = v.pages > 1 ? (v.page - 1) / (v.pages - 1) : 1;
  const chap = chapterAt(v.page);
  if (ls.get('pos:' + id, null) !== pos) {
    ls.set('pos:' + id, pos);
    ls.set('at:' + id, Date.now());
    markDirty(id);
    sync.later(5000);
  }
  ls.set('pct:' + id, pct);
  ls.set('chap:' + id, chap);
  noteProgress(pct);
  $('#chapLabel').textContent = chap;
  $('#pageInfo').textContent = `${v.page} из ${v.pages}`;
  $('#pct').textContent = Math.round(pct * 100) + '%';
  if (!scrubbing) $('#scrub').value = Math.round(pct * 1000);
}

/* ── Оглавление ── */

async function loadOutline(doc) {
  const out = [];
  let items;
  try { items = await doc.getOutline(); } catch { return out; }
  // Два уровня, как на сервере: части и главы. Глубже — уже параграфы.
  const walk = async (list, lvl) => {
    for (const it of list || []) {
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0] && it.title) {
          out.push({ title: it.title.trim(), page: (await doc.getPageIndex(dest[0])) + 1, lvl });
        }
      } catch { /* битая закладка пропускается, остальные в деле */ }
      if (lvl < 1) await walk(it.items, lvl + 1);
    }
  };
  await walk(items, 0);
  return out.sort((a, b) => a.page - b.page);
}

function chapterAt(page) {
  const v = state.pdf;
  let hit = '';
  for (const it of (v && v.outline) || []) {
    if (it.page > page) break;
    hit = it.title;
  }
  return hit;
}

/* ── Текст страницы ──
   Собирается ровно так же, как pdf.js собирает слой: кусок текста — строкой, конец
   строки — переводом (в слое ему отвечает <br>). Совпадение важно посимвольно: по этому
   тексту считаются смещения выписок, а рисуются они по слою. */

async function pageText(v, p) {
  if (v.text[p] == null) {
    try {
      const tc = await (await v.doc.getPage(p)).getTextContent();
      v.text[p] = tc.items.map(i => (i.str || '') + (i.hasEOL ? '\n' : '')).join('');
    } catch { v.text[p] = ''; }
  }
  return v.text[p];
}

/* ── Поиск ──
   Страница за страницей; распознанное кэшируется — второй запрос по той же книге
   не перечитывает её заново. */

async function search(q, cancelled, limit = 80) {
  const v = state.pdf, needle = q.toLowerCase(), out = [];
  for (let p = 1; p <= v.pages && out.length < limit; p++) {
    if ((cancelled && cancelled()) || state.pdf !== v) return out;
    const text = await pageText(v, p);
    let at = text.toLowerCase().indexOf(needle);
    while (at >= 0 && out.length < limit) {
      const s = Math.max(0, at - 80), e = Math.min(text.length, at + q.length + 80);
      out.push({ page: p, excerpt: (s ? '…' : '') + text.slice(s, e).replace(/\s+/g, ' ')
        + (e < text.length ? '…' : '') });
      at = text.toLowerCase().indexOf(needle, at + q.length);
    }
  }
  return out;
}

/* ── Выписки ──
   Якорь выписки в pdf — страница и смещения в её тексте: 'pdf:12:340-395'. Смещения
   считаются по тому же текстовому слою, который и рисуется, поэтому метка ложится
   обратно на то же место при любом размере окна. */

const MARK = /^pdf:(\d+):(\d+)-(\d+)$/;

/** Слой по кусочкам: строки текста и переносы. <br> считается одним символом — тем самым
    переводом строки, который в тексте страницы стоит на его месте. */
function pieces(root) {
  const out = [];
  for (const n of root.childNodes) {
    if (n.nodeType === 3) out.push({ node: n, len: n.textContent.length });
    else if (n.nodeName === 'BR') out.push({ br: n, len: 1 });
    else if (n.nodeType === 1) out.push(...pieces(n));
  }
  return out;
}

function offsetsOf(range) {
  let at = 0, from = -1, to = -1;
  for (const p of pieces(state.pdf.layer)) {
    if (p.node === range.startContainer) from = at + range.startOffset;
    if (p.node === range.endContainer) to = at + range.endOffset;
    at += p.len;
  }
  return from < 0 || to < 0 ? null : [from, to];
}

function rangeOf(from, to) {
  const r = document.createRange();
  let at = 0, ok = false;
  for (const p of pieces(state.pdf.layer)) {
    if (from >= at && from <= at + p.len) {
      p.node ? r.setStart(p.node, from - at) : r.setStartAfter(p.br);
    }
    if (to >= at && to <= at + p.len) {
      p.node ? r.setEnd(p.node, to - at) : r.setEndBefore(p.br);
      ok = true;
    }
    at += p.len;
  }
  return ok && !r.collapsed ? r : null;
}

/** Поверхность выделения: диапазоны живут в самом окне, якорь — страница со смещениями. */
function surface(v) {
  return {
    root: v.wrap, doc: document,
    origin: () => ({ left: 0, top: 0 }),
    anchor: range => {
      const off = offsetsOf(range);
      return off ? `pdf:${v.page}:${off[0]}-${off[1]}` : null;
    },
    chapter: () => chapterAt(v.page),
  };
}

/** Метки выписок текущей страницы. Зовётся после каждого рендера и после каждой правки. */
function drawMarks() {
  const v = state.pdf;
  if (!v || !v.marks || !v.layer) return;
  v.marks.innerHTML = '';
  const box = v.marks.getBoundingClientRect();
  live().forEach(h => {
    const m = MARK.exec(h.cfi || '');
    if (!m || +m[1] !== v.page) return;
    const r = rangeOf(+m[2], +m[3]);
    if (!r) return;
    [...r.getClientRects()].filter(q => q.width > 0.5 && q.height > 0.5).forEach(q => {
      const d = el('div', 'hlrect');
      d.dataset.id = h.id;
      d.style.cssText = `left:${q.left - box.left}px; top:${q.top - box.top}px;`
        + `width:${q.width}px; height:${q.height}px; background:${colorOf(h.color).hex}`;
      v.marks.appendChild(d);
    });
  });
}

function markAt(x, y) {
  const v = state.pdf;
  if (!v || !v.marks) return null;
  for (const d of v.marks.children) {
    const b = d.getBoundingClientRect();
    if (x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2) {
      const h = live().find(z => z.id === d.dataset.id);
      if (h) return h;
    }
  }
  return null;
}

/** Текст вокруг выписки — агенту: по одной фразе он гадает, по странице отвечает по делу. */
async function context(cfi, before = 900, after = 900) {
  const v = state.pdf, m = MARK.exec(String(cfi || ''));
  if (!v || !m) return '';
  const all = await pageText(v, +m[1]);
  return all.slice(Math.max(0, +m[2] - before), Math.min(all.length, +m[3] + after))
    .replace(/\s+/g, ' ').trim();
}

/* ── Жесты ──
   Канвас — обычный DOM, никакого iframe: тапы и свайпы вешаются на #viewer один раз.
   Тап разбирается на touchend с гашением click — как в epub-части, чтобы жест вёл
   себя одинаково в обоих движках. */

let wired = false;

function wireViewer() {
  if (wired) return;
  wired = true;
  const viewer = $('#viewer');
  const tap = x => {
    const v = viewer.getBoundingClientRect();
    const k = (x - v.left) / v.width;
    if (k < 0.22) return prev();
    if (k > 0.78) return next();
    $('#reader').classList.toggle('immersive');
  };
  let sx = 0, sy = 0, tapped = false;
  viewer.addEventListener('touchstart', e => {
    if (state.kind !== 'pdf') return;
    sx = e.changedTouches[0].clientX; sy = e.changedTouches[0].clientY;
    sel.markJust = false; tapped = false;
  }, { passive: true });
  // Пока тянут выделение — страница стоит. Слушатель непассивный, иначе preventDefault не в счёт.
  viewer.addEventListener('touchmove', e => { if (sel.on) e.preventDefault(); }, { passive: false });
  viewer.addEventListener('touchend', e => {
    if (state.kind !== 'pdf' || sel.on || e.touches.length) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      return dx < 0 ? next() : prev();
    }
    // Тап по выписке открываем в конце жеста: пока палец на экране, шторка вставать не должна.
    const h = markAt(t.clientX, t.clientY);
    if (h) { sel.markJust = true; return openHighlight(h); }
    if (Math.hypot(dx, dy) > 12) return;      // палец уехал — это не тап
    tapped = true;
    if (sel.dismissed) { sel.dismissed = false; return; }   // этим тапом сняли выделение
    tap(t.clientX);
  }, { passive: true });
  viewer.addEventListener('click', e => {
    if (state.kind !== 'pdf') return;
    if (tapped) { tapped = false; return; }   // тап уже разобран на touchend
    if (sel.justEnded) { sel.justEnded = false; return; }
    if (sel.dismissed) { sel.dismissed = false; return; }
    if (sel.markJust) { sel.markJust = false; return; }     // выписку уже открыли на touchend
    const h = markAt(e.clientX, e.clientY);
    if (h) return openHighlight(h);
    tap(e.clientX);
  });
}

/* ── Миниатюра ──
   Обложки у pdf нет — полке служит первая страница. Уменьшает тот, кто книгу открыл:
   рендер уже в руках, серверу для того же понадобился бы отдельный растеризатор. */

const THUMB_W = 300;

async function ensureThumb(entry, doc) {
  if (entry.thumb || !auth.token) return;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: THUMB_W / page.getViewport({ scale: 1 }).width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise((res, rej) =>
    c.toBlob(b => (b ? res(b) : rej(new Error('canvas молчит'))), 'image/jpeg', 0.8));
  const r = await fetch(`${API}/books/${entry.id}/thumb`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'image/jpeg' },
    body: await blob.arrayBuffer(),
  });
  if (!r.ok) return;
  entry.thumb = (await r.json()).thumb;
  saveLib(lib().map(x => x.id === entry.id ? entry : x));
}
