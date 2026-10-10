import { agent } from './agent.js'
import { auth, showAuth } from './auth.js'
import { $, ls, splash, state, toast, unsplash } from './core.js'
import { t } from './i18n.js'
import { closeDrawer } from './drawers.js'
import { drawHighlight, hideSelbar, redrawHighlights, touch } from './highlights.js'
import { caretAt, clearSel, onSelected, sel, wireSelection, wordAt } from './selection.js'
import { closeSheet, openHighlight, sheet } from './sheet.js'
import { buildShelf, hideMenu } from './shelf.js'
import { bookBytes, coverUrl } from './library.js'
import { lib, saveLib } from './store.js'
import { live, markDirty, sync } from './sync.js'
import { PAPER, applyType, fontReady } from './typeset.js'
import { noteJump, noteProgress, startReading, stopReading } from './stats.js'

/* ── Читалка ── */

/* Движок epub — отдельным куском сборки: полке он не нужен, а весит как всё остальное
   приложение. Грузится один раз, при первой книге (main.js подтягивает его заранее). */
let ePub = null, cfiTool = null;

export async function loadEpub() {
  if (ePub) return;
  const m = await import('epubjs');
  ePub = m.default; cfiTool = new m.EpubCFI();
}

export async function openBook(entry) {
  splash(t('openingBook'), entry.cover || entry.thumb ? coverUrl(entry) : '');
  // PDF — другой движок: свой рендер, своя навигация. Модуль ленивый, epub за него не платит.
  if ((entry.kind || '') === 'pdf') {
    try { return await (await import('./pdfview.js')).openPdf(entry); }
    catch (e) {
      console.warn(e);
      unsplash();
      return toast(t('bookNotOpened'));
    }
  }
  hideMenu();
  $('#scrub').disabled = true; $('#scrub').value = 0;
  try {
    // Ответ сервера, опоздавший к открытию: догоняем, только если читатель ещё не листал.
    let ready = false, late = null;
    const catchUp = () => { if (state.entry === entry && !moved) jumpTo(late.cfi); };
    await sync.pullFor(entry.id, pos => { late = pos; if (ready) catchUp(); });
    await loadEpub();
    state.entry = entry;
    state.kind = 'epub';
    state.book = ePub(await bookBytes(entry.id));
    await state.book.ready;
    state.meta = await state.book.loaded.metadata;
    state.hl = ls.get('hl:' + entry.id, []);

    entry.opened = Date.now();
    saveLib(lib().map(x => x.id === entry.id ? entry : x));

    $('#bookTitle').textContent = entry.title || state.meta.title || '';
    $('#shelf').classList.remove('on');
    $('#reader').classList.add('on');
    document.documentElement.classList.add('reading');

    await mountRendition(ls.get('pos:' + entry.id, null));
    unsplash();
    ready = true;
    if (late) catchUp();
    startReading(entry.id, ls.get('pct:' + entry.id, 0));
    buildLocations();
    if (auth.token) agent.connect().catch(() => {});   // прогреваем связь, пока читается первая страница
  } catch (e) {
    console.warn(e);
    unsplash();
    // Пароль сменили или сессия протухла — «книга не открылась» тут только запутает.
    if (/\b401\b/.test(e.message || '')) { auth.forget(); showAuth(t('sessionExpired')); }
    else toast(t('bookNotOpened'));
  }
}

export function closeBook() {
  clearSel();
  pin = null;
  scrubbing = false;
  stopReading();
  clearTimeout(sync.timer);
  sync.run().catch(() => {});
  $('#reader').classList.remove('on');
  $('#reader').classList.remove('immersive');
  $('#reader').classList.remove('pdf');
  document.documentElement.classList.remove('reading');
  $('#viewer').innerHTML = '';
  if (state.pdf) { try { state.pdf.free(); state.pdf.doc.destroy(); } catch {} }
  state.pdf = null; state.kind = '';
  state.rendition = null; state.book = null; state.entry = null;
  buildShelf();
}

/* Разворот в две страницы — как в iBooks на широком экране: epub.js делит колонку сам,
   от нас нужен только порог, ниже которого разворот бессмысленен. */
export const SPREAD_MIN = 900;
export const PAGE_PAD_Y = 14;

/* Поля страницы из двух слагаемых: внутри iframe — половина зазора колонок epub.js,
   снаружи — ширина полосы #viewer (классы в style.css). Широкие поля заодно укорачивают
   строку: полоса становится уже порога разворота, и книга складывается в одну колонку. */
export const GAPS = { narrow: 32, normal: 44, wide: 72 };

export function syncMargin() {
  const r = $('#reader');
  r.classList.toggle('m-narrow', state.margin === 'narrow');
  r.classList.toggle('m-wide', state.margin === 'wide');
}

/* Место под полосы держит паддинг #reader, и высоту полос нельзя угадывать константой:
   у них свои отступы, кегль и безопасная зона — промах прячет строку под шапкой. */
export function syncChrome() {
  const r = $('#reader');
  r.style.paddingTop = $('#topbar').offsetHeight + 'px';
  r.style.paddingBottom = $('#botbar').offsetHeight + 'px';
}

/* Видимая высота — не то же, что высота раскладки: в Safari адресная строка то прячется,
   то возвращается, и `inset: 0` продолжает считать её частью страницы. Колонка, посчитанная
   по раскладке, оказывается на строку выше видимого — эту строку и режет край экрана. */
export function availHeight() {
  const h = $('#viewer').clientHeight;
  const vv = window.visualViewport;
  if (!vv) return h;
  const chrome = $('#topbar').offsetHeight + $('#botbar').offsetHeight;
  return Math.min(h, Math.floor(vv.height) - chrome);
}

/* Колонка epub.js ровно во всю высоту окна, и нижняя строка почти всегда обрезана пополам.
   Подгоняем высоту под целое число строк — этим читалка и отличается от скролла в браузере.
   Плюс держим внизу запас в одну строку: любой промах на строку (смена кегля, уехавшая
   адресная строка, переполнение колонки движком) тогда просто попадёт в поле,
   а не будет обрезан пополам. */
export let pageReserve = 0;

export async function fitLines() {
  const v = $('#viewer');
  v.style.flex = ''; v.style.height = '';
  if (state.flow !== 'paginated' || !state.rendition) return;
  const c = state.rendition.getContents()[0];
  if (!c) return;
  const lh = lineHeight(c);
  const avail = availHeight();
  if (!lh || avail < lh * 5) return;
  setPageReserve(Math.ceil(lh));
  const pad = 2 * PAGE_PAD_Y + pageReserve;
  const want = Math.round(pad + Math.floor((avail - pad) / lh) * lh);
  v.style.flex = 'none'; v.style.height = want + 'px';
  const frame = $('#viewer iframe');
  const now = frame ? Math.round(frame.getBoundingClientRect().height) : 0;
  if (Math.abs(now - want) <= 1) return;            // уже нужной высоты — не трогаем
  const cur = state.rendition.currentLocation();
  const cfi = cur && cur.start ? cur.start.cfi : null;
  // Менеджер на ресайзе выбрасывает страницы и возвращает их сам — но только если уже
  // знает текущую позицию. Сразу после display он её ещё не посчитал, тогда рисуем мы.
  const knows = !!(state.rendition.location && state.rendition.location.start);
  // currentLocation выше уже замерил сцену и записал новый размер в кэш менеджера —
  // его resize сравнит с кэшем, решит «не изменилось» и не пересоберёт страницы.
  // Кэш сбрасываем: пересборка здесь и есть цель (0.3.93, поведение прибито тестом).
  state.rendition.manager._stageSize = undefined;
  state.rendition.resize();
  if (!knows) await state.rendition.display(cfi || undefined);
}

export function setPageReserve(px) {
  if (px === pageReserve) return;
  pageReserve = px;
  applyTouchRules();
}

export function lineHeight(contents) {
  const doc = contents.document;
  const p = [...doc.body.querySelectorAll('p, [data-rp]')].find(x => x.textContent.trim().length > 120)
    || doc.body.querySelector('p, li, div');
  if (!p) return 0;
  const cs = contents.window.getComputedStyle(p);
  let lh = parseFloat(cs.lineHeight);          // line-height: normal → NaN
  if (!lh) {
    const rects = p.getClientRects();
    lh = rects.length > 1 ? rects[0].height : parseFloat(cs.fontSize) * 1.4;
  }
  return lh > 4 ? lh : 0;
}

export function syncSpread() {
  const on = state.flow === 'paginated' && state.spread === 'auto' && $('#viewer').clientWidth >= SPREAD_MIN;
  $('#viewer').classList.toggle('spread', on);
}

/* ── Где читатель на самом деле ──
   Страница выравнивается по колонке: epub.js показывает ту колонку, в которую попал CFI,
   а началом страницы становится текст перед ним. Пока раскладка не менялась, начало
   страницы и есть позиция — но стоит колонке стать другой (новый запуск, другой кегль,
   уехавшая адресная строка), и сохранённое начало съезжает на страницу назад. Ещё запуск —
   ещё страница. Поэтому позицию держит якорь: перекладка его не двигает — двигает только
   перелистывание и переход. */
let pin = null, lastStart = null;
let moved = false;       // читатель уже ушёл со страницы, на которой книга открылась

const before = (a, b) => { try { return cfiTool.compare(a, b) < 0; } catch { return false; } };
const onScreen = (loc, at) => !before(at, loc.start.cfi) && !before(loc.end ? loc.end.cfi : loc.start.cfi, at);

/** Переход по книге: оглавление, поиск, ползунок, выписка. Цель прыжка и есть новая
    позиция — страница вокруг неё почти всегда начинается раньше. */
export async function jumpTo(target) {
  // Место в pdf — просто страница: и позиция, и якорь выписки начинаются с 'pdf:'.
  if (state.kind === 'pdf') {
    const m = /^pdf:(\d+)/.exec(String(target || ''));
    if (m && state.pdf) return state.pdf.goto(+m[1]);
    return;
  }
  noteJump();
  pin = typeof target === 'string' && target.startsWith('epubcfi(') ? target : null;
  try { await state.rendition.display(target); } catch { toast(t('placeNotFound')); }
}

/** Создать rendition и навесить всё, что к нему прилагается. Общее для открытия и пересборки. */
export async function mountRendition(at) {
  // Гарнитура должна быть скачана до первой раскладки, иначе страница переедет на глазах.
  const book = state.book;
  await fontReady();
  if (state.book !== book) return;
  pin = at || null;
  lastStart = null;
  moved = false;
  $('#viewer').innerHTML = '';
  syncChrome();
  syncMargin();
  state.rendition = state.book.renderTo('viewer', {
    width: '100%', height: '100%',
    flow: state.flow === 'scrolled' ? 'scrolled-doc' : 'paginated',
    spread: state.flow === 'paginated' && state.spread === 'auto' ? 'auto' : 'none',
    minSpreadWidth: SPREAD_MIN,
    gap: GAPS[state.margin] || GAPS.normal,   // половина зазора становится полем страницы
    allowScriptedContent: true,
  });
  applyTheme();
  wireContent();
  // Книгу могут закрыть, пока она ещё раскладывается: после каждого ожидания проверяем,
  // что это по-прежнему наш rendition, иначе дорисовываем в пустоту и падаем.
  const mine = state.rendition;
  await state.rendition.display(at || undefined);
  if (state.rendition !== mine) return;
  await fitLines();
  if (state.rendition !== mine) return;
  // Колонку подогнали — встаём ровно там, где бросили: первый показ считался по другой высоте.
  if (at) { await state.rendition.display(at); if (state.rendition !== mine) return; }
  live().forEach(drawHighlight);
  syncSpread();

  state.rendition.on('relocated', loc => {
    const id = state.entry.id;
    // Перекладка показывает то же место заново: epub.js возвращается к началу прежней
    // страницы, и оно попадает в новую — по этому её и узнаём. Такой переезд читателя
    // не двигает, а вот перелистывание уводит с прежнего начала, и якорь идёт следом.
    // Назад якорь не ходит никогда, вперёд — идёт за страницей: её читатель и видит.
    const same = lastStart && onScreen(loc, lastStart);
    if (lastStart && !same) moved = true;
    const stay = state.flow === 'paginated' && pin
      && (onScreen(loc, pin) || (same && !before(pin, loc.start.cfi)));
    if (!stay) pin = loc.start.cfi;
    lastStart = loc.start.cfi;
    if (ls.get('pos:' + id, null) !== pin) {
      ls.set('pos:' + id, pin);
      ls.set('at:' + id, Date.now());
      markDirty(id);
      sync.later(5000);
    }
    const chap = chapterName(loc.start.href) || '';
    ls.set('chap:' + id, chap);
    $('#chapLabel').textContent = chap;
    const d = loc.start.displayed;
    $('#pageInfo').textContent = state.flow === 'paginated' && d && d.total ? t('pageOf', d.page, d.total) : '';
    if (state.book.locations.length()) {
      const p = state.book.locations.percentageFromCfi(pin) || 0;
      ls.set('pct:' + id, p);
      noteProgress(p);
      $('#pct').textContent = Math.round(p * 100) + '%';
      if (!scrubbing) $('#scrub').value = Math.round(p * 1000);
    }
    clearSel();
    syncSpread();
  });
  state.rendition.on('selected', onSelected);
  // Перекладку epub.js доигрывает сам: показывает начало прежней страницы — то есть уже
  // прочитанный текст. Цель он берёт из своей же location, и её мы подменяем на якорь:
  // так возврат к нужному месту делает он сам, одним показом, и перелистывание,
  // случившееся в тот же миг, ничем не перебивается.
  state.rendition.on('resized', () => {
    const loc = state.rendition.location;
    if (pin && loc && loc.start) loc.start.cfi = pin;
  });
}

/* Попадание по выписке считаем сами. Свой markClicked epub.js зовёт ещё на touchstart —
   шторка встаёт под палец, и click, прилетающий следом, попадает уже в затемнение. */
export function hlAt(x, y) {
  if (state.kind === 'pdf') return state.pdf ? state.pdf.hlAt(x, y) : null;
  for (const g of document.querySelectorAll('#viewer svg g[data-id]')) {
    for (const r of g.children) {
      const b = r.getBoundingClientRect();
      if (!b.width) continue;
      if (x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2) {
        const h = live().find(v => v.id === g.dataset.id);
        if (h) return h;
      }
    }
  }
  return null;
}

/** Точку внутри книги — в координаты окна: полоса выписок живёт в родителе. */
export function inWindow(contents, x, y) {
  const fr = contents.document.defaultView.frameElement.getBoundingClientRect();
  return [fr.left + x, fr.top + y];
}

/** Глава epub как поверхность выделения: точка — каретка, отрезок — диапазон, якорь — cfi.
    Текст перетекает по колонкам, поэтому порядок точек знает сам браузер. */
export function epubSurface(contents) {
  const doc = contents.document;
  const caret = (node, at) => { const r = doc.createRange(); r.setStart(node, at); r.collapse(true); return r; };
  return {
    root: doc, doc,
    origin: () => doc.defaultView.frameElement.getBoundingClientRect(),
    at: (x, y) => caretAt(doc, x, y),
    word: (x, y) => {
      const r = wordAt(doc, x, y);
      return r && [caret(r.startContainer, r.startOffset), caret(r.endContainer, r.endOffset)];
    },
    span: (a, b) => {
      const back = a.compareBoundaryPoints(Range.START_TO_START, b) > 0;
      const [from, to] = back ? [b, a] : [a, b];
      const r = doc.createRange();
      r.setStart(from.startContainer, from.startOffset);
      r.setEnd(to.endContainer, to.endOffset);
      if (r.collapsed) return null;
      return {
        from, to, text: r.toString(),
        rects: [...r.getClientRects()].filter(q => q.width > 0.5 && q.height > 0.5),
        id: () => contents.cfiFromRange(r),
      };
    },
    chapter: () => {
      const loc = state.rendition && state.rendition.currentLocation();
      return chapterName(loc && loc.start ? loc.start.href : '') || '';
    },
  };
}

/* Пересборка — это три раскладки подряд (показ, подгонка строк, возврат на место).
   Прячем их за вуалью цвета страницы: текст не прыгает на глазах, а проявляется готовым. */
export async function reopen() {
  clearSel();
  const v = $('#viewer');
  v.classList.add('veil');
  try { await mountRendition(ls.get('pos:' + state.entry.id, null)); }
  finally { v.classList.remove('veil'); }
}

/* Локации считаются медленно — раз на книгу, дальше из кэша. */
export async function buildLocations() {
  // Считаются они долго, и книгу за это время могут закрыть или сменить.
  const mine = state.entry;
  if (!mine) return;
  const id = mine.id;
  const cached = ls.get('loc:' + id, null);
  try {
    if (cached) state.book.locations.load(cached);
    else {
      await state.book.locations.generate(1600);
      if (state.entry !== mine) return;
      ls.set('loc:' + id, state.book.locations.save());
    }
  } catch { return; }
  if (state.entry !== mine) return;
  const cur = state.rendition && state.rendition.currentLocation();
  if (cur && cur.start) {
    const p = state.book.locations.percentageFromCfi(cur.start.cfi) || 0;
    ls.set('pct:' + id, p);
    $('#pct').textContent = Math.round(p * 100) + '%';
    $('#scrub').value = Math.round(p * 1000);
  }
  // Без локаций проценты не посчитать, а значит и тащить ползунок некуда.
  $('#scrub').disabled = false;
}

/* Ползунок прогресса: долистать до нужного места — занятие на весь вечер, а
   «примерно на трети» человек помнит лучше, чем номер главы. */
export let scrubbing = false;

export function wireScrub() {
  const s = $('#scrub');
  const ready = () => (state.kind === 'pdf' && state.pdf)
    || (state.book && state.book.locations && state.book.locations.length());
  const pdfPage = () => 1 + Math.round((s.value / 1000) * (state.pdf.pages - 1));
  s.addEventListener('input', () => {
    if (!ready()) return;
    scrubbing = true;
    const p = s.value / 1000;
    $('#pct').textContent = Math.round(p * 100) + '%';
    // Пока тянут — показываем, куда попадём: проценты без главы ни о чём не говорят.
    if (state.kind === 'pdf') {
      const page = pdfPage();
      $('#chapLabel').textContent = state.pdf.labelAt(page) || '';
      $('#pageInfo').textContent = t('pageOf', page, state.pdf.pages);
      return;
    }
    const cfi = state.book.locations.cfiFromPercentage(p);
    const item = cfi && state.book.spine.get(cfi);
    if (item) $('#chapLabel').textContent = chapterName(item.href) || '';
  });
  const jump = async () => {
    if (!ready() || !scrubbing) return;
    scrubbing = false;
    if (state.kind === 'pdf') return state.pdf.goto(pdfPage());
    const cfi = state.book.locations.cfiFromPercentage(s.value / 1000);
    if (!cfi) return;
    await jumpTo(cfi);
  };
  s.addEventListener('change', jump);
  // Safari на тач-экране до change доходит не всегда — отпустили палец, значит прыгаем.
  s.addEventListener('touchend', jump, { passive: true });
}

/* ── Поиск по книге ──
   Ищем по самой книге, а не по тексту с сервера: только так у находки есть CFI, то есть
   на неё можно перейти. Главы грузятся по одной и тут же выгружаются — иначе книга
   целиком окажется в памяти телефона. */
export async function findInBook(q, cancelled, limit = 80) {
  const out = [];
  for (const item of state.book.spine.spineItems) {
    if (cancelled && cancelled()) return out;
    try {
      await item.load(state.book.load.bind(state.book));
      const chapter = chapterName(item.href) || '';
      (item.find(q) || []).forEach(h => out.push({ cfi: h.cfi, excerpt: h.excerpt, chapter }));
    } catch { /* глава не разобралась — ищем дальше по остальным */ }
    try { item.unload(); } catch {}
    if (out.length >= limit) break;
  }
  return out;
}

/** Подсветить находку на пару секунд: иначе на странице непонятно, куда смотреть. */
export function flashFind(cfi) {
  if (live().some(h => h.cfi === cfi)) return;      // там уже своя выписка — не трогаем
  try {
    state.rendition.annotations.highlight(cfi, {}, () => {}, 'hl-find',
      { fill: '#F5C64A', 'fill-opacity': '.45' });
    setTimeout(() => { try { state.rendition.annotations.remove(cfi, 'highlight'); } catch {} }, 2600);
  } catch {}
}

export function chapterName(href) {
  const toc = (state.book.navigation && state.book.navigation.toc) || [];
  const flat = [];
  const walk = items => items.forEach(i => { flat.push(i); if (i.subitems) walk(i.subitems); });
  walk(toc);
  const hit = flat.find(i => i.href && href && i.href.split('#')[0].endsWith(href.split('/').pop()));
  return hit ? hit.label.trim() : '';
}

export function resolvedTheme() {
  if (state.theme !== 'auto') return state.theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme() {
  const th = resolvedTheme();
  const root = document.documentElement;
  // Чёрная — та же тёмная, только бумага другая: интерфейсу хватает одного признака.
  root.dataset.theme = th === 'black' ? 'dark' : th;
  root.dataset.page = th;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = PAPER[th][0];
  applyType();
}

/* Набор поменяли — страница стала другой длины. Ждём, пока рука остановится, подгоняем
   колонку под новую строку и возвращаемся к якорю: иначе на экране окажется другое место. */
let settleT = null;
export function settle(ms = 180) {
  clearTimeout(settleT);
  settleT = setTimeout(async () => {
    const r = state.rendition;
    if (!r) return;
    await fitLines();
    if (state.rendition !== r) return;
    if (pin) { try { await r.display(pin); } catch {} }
    if (state.rendition !== r) return;
    redrawHighlights();
  }, ms);
}

/* Отдельным <style> от набора: запас внизу страницы меняется сам по себе, с каждой подгонкой. */
export function applyTouchRules() {
  if (!state.rendition) return;
  state.rendition.getContents().forEach(c => {
    const doc = c.document;
    let st = doc.getElementById('reader-touch');
    if (!st) { st = doc.createElement('style'); st.id = 'reader-touch'; doc.head.appendChild(st); }
    // Браузер не должен уметь выделять: нет выделения — нечего и показывать поверх.
    // touch-action забирает у него и жест: иначе он объявляет касание прокруткой,
    // шлёт pointercancel — и удержание не доживает до своих 330 мс.
    const pan = state.flow === 'scrolled' ? 'pan-y' : 'none';
    st.textContent =
      '* { -webkit-touch-callout: none !important; -webkit-user-select: none !important; user-select: none !important; }'
      + 'html, body { touch-action: ' + pan + ' !important; overscroll-behavior: none !important; }'
      // Запас внизу страницы — в пару к fitLines; селектор с html, чтобы перебить правило набора.
      + (state.flow === 'paginated' && pageReserve
        ? 'html body { padding-bottom: ' + (PAGE_PAD_Y + pageReserve) + 'px !important; }' : '');
  });
}

/* Листание epub. Сама страница меняется мгновенно — epub.js сдвигает ленту главы, — и глаз
   видит скачок. Поэтому текст на мгновение гаснет со сдвигом в сторону листания и
   проявляется уже новым. Вести страницу пальцем нельзя: глава — одна прокручиваемая
   лента, и на границе глав соседней страницы просто нет. */
let turning = false;
export async function turn(dir) {
  const r = state.rendition;
  if (!r) return;
  const go = () => Promise.resolve(dir > 0 ? r.next() : r.prev()).catch(() => {});
  const v = $('#viewer');
  // Листают быстрее анимации — не копим очередь затуханий, просто листаем.
  if (turning || !v.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return go();
  turning = true;
  const out = v.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-dir * 12}px)` }],
    { duration: 90, easing: 'ease-in', fill: 'forwards' });
  try {
    await out.finished;
    // Последняя страница книги: next() может не ответить — ждём недолго.
    await Promise.race([go(), new Promise(res => setTimeout(res, 600))]);
  } catch { /* анимацию отменили — показываем как есть */ }
  out.cancel();
  v.animate([{ opacity: 0, transform: `translateX(${dir * 12}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 150, easing: 'ease-out' });
  turning = false;
}

export function wireContent() {
  state.rendition.hooks.content.register(contents => {
    const doc = contents.document;
    applyType();
    wireSelection(epubSurface(contents));
    // Переносы работают, только когда браузер знает язык текста, а главы без lang — не редкость.
    const lang = ((state.meta && state.meta.language) || '').split('-')[0];
    if (lang && !doc.documentElement.lang) doc.documentElement.lang = lang;
    // Фокус живёт внутри книги, и до родителя её клавиши не долетают.
    doc.addEventListener('keydown', onKey);

    // Тап: у краёв — листаем, посередине — прячем и возвращаем полосы. Координата — оконная:
    // внутри iframe лежит вся глава колонками, и её ширина ничего не знает о видимой странице.
    const tap = x => {
      const v = $('#viewer').getBoundingClientRect();
      const k = (x - v.left) / v.width;
      if (state.flow === 'paginated' && k < 0.22) return turn(-1);
      if (state.flow === 'paginated' && k > 0.78) return turn(1);
      $('#reader').classList.toggle('immersive');
      hideSelbar();
    };

    let sx = 0, sy = 0, tapped = false;
    doc.addEventListener('touchstart', e => {
      sx = e.changedTouches[0].clientX; sy = e.changedTouches[0].clientY;
      sel.markJust = false; tapped = false;     // новый жест — прошлые флаги больше не в счёт
    }, { passive: true });
    // Пока тянем выделение — страница стоит. Слушатель непассивный, иначе preventDefault не в счёт.
    doc.addEventListener('touchmove', e => { if (sel.on) e.preventDefault(); }, { passive: false });
    doc.addEventListener('touchend', e => {
      if (sel.on || e.touches.length) return;   // тянем выделение или второй палец — не жест
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (state.flow === 'paginated' && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        return dx < 0 ? turn(1) : turn(-1);
      }
      // Тап по выписке открываем в конце жеста, а не в начале: пока палец на экране,
      // ничего поверх книги вставать не должно — иначе оно и съест этот тап.
      const h = hlAt(...inWindow(contents, t.clientX, t.clientY));
      if (h) { sel.markJust = true; return openHighlight(h); }
      // Обычный тап тоже разбираем здесь: click внутрь книги iOS не доносит.
      if (Math.hypot(dx, dy) > 12) return;      // палец уехал — это не тап
      tapped = true;
      if (sel.dismissed) { sel.dismissed = false; return; }   // этим тапом сняли выделение — и хватит с него
      tap(inWindow(contents, t.clientX, t.clientY)[0]);
    }, { passive: true });
    doc.addEventListener('click', e => {
      if (tapped) { tapped = false; return; }   // тап уже разобран на touchend
      if (sel.justEnded) { sel.justEnded = false; return; }
      if (sel.dismissed) { sel.dismissed = false; return; }   // этим кликом сняли выделение — и хватит с него
      if (sel.markJust) { sel.markJust = false; return; }     // выписку уже открыли на touchend
      const hit = hlAt(...inWindow(contents, e.clientX, e.clientY));
      if (hit) return openHighlight(hit);
      tap(inWindow(contents, e.clientX, e.clientY)[0]);
    });
  });
}

/** Подогнать всё к текущему окну — сразу, без ожидания. */
export function relayoutNow() {
  syncChrome();
  if (state.kind === 'pdf') { if (state.pdf) state.pdf.refit(); return; }
  fitLines(); syncSpread();
}

/** Отпечаток окна: по нему шторка и ящик понимают, менялось ли окно, пока они были открыты. */
export function windowSig() {
  const vv = window.visualViewport;
  return window.innerWidth + 'x' + window.innerHeight + '/' + (vv ? Math.floor(vv.height) : 0);
}

/* Родительские слушатели вешаются один раз: rendition пересобирается при смене вида,
   а вместе с ним удвоились бы и перелистывания. */
export function wireGlobal() {
  document.addEventListener('keydown', onKey);
  let rt = null;
  const relayout = () => {
    if (sel.on || sel.drag) return;      // тянут выделение — не перекладывать под рукой
    // Открытая шторка или ящик — это клавиатура: она сжимает видимую область, но
    // перекладывать под неё книгу нельзя — текст «уезжает» и остаётся огрызок страницы.
    // Разъедутся окно и раскладка — закрытие шторки подгонит (relayoutNow).
    if ($('#sheet').classList.contains('on') || $('#drawer').classList.contains('on')) return;
    clearSel(); hideMenu();
    clearTimeout(rt);
    rt = setTimeout(relayoutNow, 180);
  };
  window.addEventListener('resize', relayout);
  // Прятанье адресной строки меняет видимую область, но не всегда шлёт window.resize.
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', relayout);
    window.visualViewport.addEventListener('scroll', relayout);
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'auto') applyTheme();
  });

  // Уходя со страницы — дописать прогресс, возвращаясь — забрать чужой.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { clearTimeout(sync.timer); sync.run({ keepalive: true }).catch(() => {}); }
    else if (Date.now() - sync.last > 30000) sync.later(600);
  });
  window.addEventListener('pagehide', () => { clearTimeout(sync.timer); sync.run({ keepalive: true }).catch(() => {}); });

  // Нажатие мимо книги — по хрому, по полям, по чему угодно в родителе — снимает выделение.
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest || !e.target.closest('#menu')) hideMenu();
    const had = sel.on || $('#selbar').classList.contains('on');
    sel.dismissed = false;
    if (!had) return;
    // Страница pdf лежит в том же документе, и её собственный слушатель разберётся сам —
    // иначе снятие выделения посчиталось бы дважды, и тап заодно перелистнул бы страницу.
    if (e.target.closest('#selbar, #selLayer, .pdfwrap')) return;
    clearSel();
    sel.dismissed = true;
  }, true);

  // На широком экране полоса текста уже окна: поля по бокам — тоже листалка.
  $('#reader').addEventListener('click', e => {
    if (e.target !== e.currentTarget) return;
    if (sel.dismissed) { sel.dismissed = false; return; }
    if (state.kind === 'pdf' && state.pdf) {
      e.clientX < window.innerWidth / 2 ? state.pdf.prev() : state.pdf.next();
      return;
    }
    if (state.flow !== 'paginated' || !state.rendition) return;
    e.clientX < window.innerWidth / 2 ? turn(-1) : turn(1);
  });
}

export function onKey(e) {
  if (e.key === 'Escape') {
    if (sel.on || $('#selbar').classList.contains('on')) return clearSel();
    if ($('#sheet').classList.contains('on')) return closeSheet();
    if ($('#drawer').classList.contains('on')) return closeDrawer();
    $('#reader').classList.remove('immersive');
    return;
  }
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (state.kind === 'pdf' && state.pdf) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); state.pdf.next(); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); state.pdf.prev(); }
    return;
  }
  if (!state.rendition || state.flow !== 'paginated') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); turn(1); }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); turn(-1); }
}
