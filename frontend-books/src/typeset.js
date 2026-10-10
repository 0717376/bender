import { el, escapeHtml, ls, state } from './core.js'
import { t } from './i18n.js'
import { PAGE_PAD_Y, applyTheme, applyTouchRules, reopen, resolvedTheme, settle } from './reader.js'

/* ── Набор текста ──
   Всё, что читатель крутит в панели «Вид»: гарнитура, кегль, интерлиньяж, насыщенность,
   разрядка, абзацы, выключка, переносы. Правила уходят в книгу одним своим <style>:
   его текст переписывается целиком, поэтому любая правка видна сразу, под рукой. */

export const TYPE_DEFAULTS = { font: 'system', lh: 1.55, weight: 400, track: 0, align: 'justify', hyph: true, para: 'book' };
export const SIZE_DEFAULT = 108;

/* Гарнитуры — только с настоящей кириллицей и курсивом: подмена шрифта посреди слова
   выглядит хуже любого шрифта. Файлы лежат в сборке и работают без сети; грузится
   только выбранная. `w` — диапазон насыщенности у вариативных. */
export const FONTS = {
  original: { name: null, stack: null },
  system:   { name: null, stack: 'ui-serif, "New York", Georgia, serif' },
  literata: { name: 'Literata', family: 'Literata Variable', serif: true, w: [300, 700],
    css: () => [import('@fontsource-variable/literata/wght.css?inline'), import('@fontsource-variable/literata/wght-italic.css?inline')] },
  source:   { name: 'Source Serif', family: 'Source Serif 4 Variable', serif: true, w: [300, 700],
    css: () => [import('@fontsource-variable/source-serif-4/wght.css?inline'), import('@fontsource-variable/source-serif-4/wght-italic.css?inline')] },
  lora:     { name: 'Lora', family: 'Lora Variable', serif: true, w: [400, 700],
    css: () => [import('@fontsource-variable/lora/wght.css?inline'), import('@fontsource-variable/lora/wght-italic.css?inline')] },
  ptserif:  { name: 'PT Serif', family: 'PT Serif', serif: true,
    css: () => [import('@fontsource/pt-serif/400.css?inline'), import('@fontsource/pt-serif/400-italic.css?inline'),
                import('@fontsource/pt-serif/700.css?inline'), import('@fontsource/pt-serif/700-italic.css?inline')] },
  inter:    { name: 'Inter', family: 'Inter Variable', w: [300, 700],
    css: () => [import('@fontsource-variable/inter/wght.css?inline'), import('@fontsource-variable/inter/wght-italic.css?inline')] },
  manrope:  { name: 'Manrope', family: 'Manrope Variable', w: [300, 700],
    css: () => [import('@fontsource-variable/manrope/wght.css?inline')] },
};
const fontOf = id => FONTS[id] || FONTS.system;
const stackOf = f => f.stack || `"${f.family}", ${f.serif ? 'ui-serif, Georgia, serif' : 'system-ui, sans-serif'}`;

/* Бумага и краска по темам. Чёрная — для OLED в темноте: краска приглушена, иначе
   белое на чёрном режет глаз. */
export const PAPER = {
  light: ['#FBFAF8', '#1A1A1F'], sepia: ['#F6EEDC', '#43382B'],
  dark: ['#16151A', '#E8E4DE'], black: ['#000000', '#BDB9B2'],
};

/* @font-face выбранной гарнитуры: один текст и для книги (iframe), и для родителя.
   Адреса делаем полными — у главы, открытой из blob:, своей базы для них нет. */
const faces = new Map();
async function loadFaces(id) {
  const f = fontOf(id);
  if (!f.css) return '';
  if (!faces.has(id)) {
    const parts = await Promise.all(f.css());
    faces.set(id, parts.map(m => m.default).join('\n').replace(/url\(\//g, 'url(' + location.origin + '/'));
  }
  const css = faces.get(id);
  let st = document.getElementById('face-' + id);
  if (!st) { st = el('style'); st.id = 'face-' + id; st.textContent = css; document.head.appendChild(st); }
  return css;
}

/** Гарнитура готова к показу: файлы скачаны родителем, и глава возьмёт их уже из кэша —
    иначе страница сперва разложится запасным шрифтом, а потом переедет на глазах. */
export async function fontReady(id = state.type.font) {
  const f = fontOf(id);
  if (!f.css) return;
  try {
    await loadFaces(id);
    const probe = 'Книга book';
    await Promise.all([`400 16px "${f.family}"`, `italic 400 16px "${f.family}"`, `700 16px "${f.family}"`]
      .map(d => document.fonts.load(d, probe)));
  } catch (e) { console.warn(e); }
}

export function typeCss() {
  const T = state.type, f = fontOf(T.font);
  const [paper, ink] = PAPER[resolvedTheme()] || PAPER.light;
  const own = T.font !== 'original';
  const text = 'p, li, blockquote, dd, [data-rp]';
  const para = 'p:not([data-keep]), [data-rp]:not([data-keep])';
  const w = f.w ? Math.max(f.w[0], Math.min(f.w[1], T.weight)) : 400;
  const out = [faces.get(T.font) || ''];
  /* Вертикальные поля страницы: epub.js делает body контейнером колонок, поэтому
     padding-top/bottom одинаково отступает во всех колонках разворота. */
  out.push(`body { color: ${ink} !important; background: ${paper} !important;
    padding: ${PAGE_PAD_Y}px 4px !important; -webkit-text-size-adjust: 100%;
    font-size: ${state.fontSize}% !important;
    text-rendering: optimizeLegibility; font-kerning: normal;
    font-variant-ligatures: common-ligatures; }`);
  out.push(`p, li, td, div, span, h1, h2, h3, h4, h5, h6 { color: ${ink} !important; }`);
  /* Свои шрифты и интерлиньяж книги перебиваем сознательно: в читалке текст важнее
     фирменного стиля вёрстки. «Как в книге» оставляет гарнитуру издателя. */
  if (own) {
    out.push(`body { font-family: ${stackOf(f)} !important; }`);
    out.push(`body *:not(pre):not(code):not(kbd):not(samp):not(tt):not(pre *) { font-family: inherit !important; }`);
  }
  out.push(`body { line-height: ${T.lh}; }`);
  out.push(`${text} { line-height: ${T.lh} !important; letter-spacing: ${T.track / 100}em !important;
    -webkit-hyphens: ${T.hyph ? 'auto' : 'manual'} !important; hyphens: ${T.hyph ? 'auto' : 'manual'} !important;
    -webkit-hyphenate-limit-before: 3; -webkit-hyphenate-limit-after: 3; -webkit-hyphenate-limit-lines: 2;
    orphans: 2; widows: 2; }`);
  // Сноска не должна раздвигать строку: иначе интерлиньяж гуляет от абзаца к абзацу.
  out.push('sup, sub { line-height: 0 !important; }');
  if (f.w && w !== 400) {
    out.push(`${text} { font-weight: ${w} !important; }`);
    // Жирное должно остаться жирнее основного текста, какой бы плотности он ни был.
    out.push(`b, strong, th, h1, h2, h3, h4, h5, h6, ${text.split(', ').map(s => s + ' b, ' + s + ' strong').join(', ')}
      { font-weight: ${Math.min(900, w + 300)} !important; }`);
  }
  /* Выключку и абзац ставим жёстко — классы книги иначе сильнее. Нарочно выровненное
     автором (эпиграфы, стихи, подписи по центру) помечено data-keep и остаётся как было. */
  out.push(T.align === 'justify' ? `${para} { text-align: justify !important; hanging-punctuation: first last; }`
    : `${para} { text-align: left !important; }`);
  /* Абзац — либо красная строка без отбивки (книга), либо отбивка без красной строки (веб).
     После заголовка красная строка не нужна: абзац и так начат. */
  if (T.para === 'indent') {
    out.push(`${para} { text-indent: 1.4em !important; margin-top: 0 !important; margin-bottom: 0 !important; }`);
    out.push(`:is(h1, h2, h3, h4, h5, h6, hr) + :is(p, [data-rp]), blockquote :is(p, [data-rp]) { text-indent: 0 !important; }`);
  } else if (T.para === 'gap') {
    out.push(`${para} { text-indent: 0 !important; margin-top: 0 !important; margin-bottom: .8em !important; }`);
  }
  out.push(`a { color: ${resolvedTheme() === 'light' || resolvedTheme() === 'sepia' ? '#C05A39' : '#DB8456'} !important; }`);
  // Без ограничения по высоте картинка на всю страницу вылезает за экран и режется.
  out.push('img, svg { max-width: 100% !important; max-height: 96vh !important; height: auto !important; object-fit: contain; }');
  out.push('table { max-width: 100% !important; }');
  out.push('pre, code { white-space: pre-wrap !important; word-break: break-word; }');
  return out.join('\n');
}

/* Разметить главу один раз, до своих правил. Книги верстают абзацы не только в <p>:
   часто это <div> с текстом — их помечаем data-rp, чтобы набор до них дотянулся.
   И запоминаем, что автор выровнял сам (по центру, вправо): это выключка не трогает. */
function markText(doc, st) {
  const root = doc.documentElement;
  if (root.dataset.rm) return;
  root.dataset.rm = '1';
  if (st) st.disabled = true;           // смотрим на вёрстку книги, а не на свою
  const win = doc.defaultView;
  doc.body.querySelectorAll('div').forEach(d => {
    for (const n of d.childNodes) {
      if (n.nodeType === 3 && n.nodeValue.trim()) { d.dataset.rp = '1'; break; }
    }
  });
  doc.body.querySelectorAll('p, [data-rp]').forEach(p => {
    const a = win.getComputedStyle(p).textAlign;
    if (a === 'center' || a === 'right' || a === 'end' || a === '-webkit-center' || a === '-webkit-right') p.dataset.keep = '1';
  });
  if (st) st.disabled = false;
}

/** Переписать правила набора во всех открытых главах. */
export function applyType() {
  if (!state.rendition) return;
  const css = typeCss();
  state.rendition.getContents().forEach(c => {
    const doc = c.document;
    let st = doc.getElementById('reader-type');
    markText(doc, st);
    if (!st) { st = doc.createElement('style'); st.id = 'reader-type'; doc.head.appendChild(st); }
    if (st.textContent !== css) st.textContent = css;
  });
  applyTouchRules();
}

/* ── Панель «Вид» ── */

const ICON = {
  justify: 'M3 6h18M3 12h18M3 18h18', left: 'M3 6h18M3 12h12M3 18h16',
  indent: 'M9 6h12M3 12h18M3 18h18', gap: 'M3 5h18M3 9h13M3 15h18M3 19h11', book: 'M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2zM22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z',
  lh: 'M11 6h10M11 12h10M11 18h10M5 5v14M2.5 7.5L5 5l2.5 2.5M2.5 16.5L5 19l2.5-2.5',
  weight: 'M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z',
  track: 'M3 6v12M21 6v12M8 16l4-8 4 8M9.4 13.5h5.2',
};
const svg = d => `<svg class="icon" viewBox="0 0 24 24"><path d="${d}"/></svg>`;

const saveType = () => ls.set('set:type', state.type);

/* Тема — образцом, а не словом: бумагу и краску видно до нажатия. */
export function themePicker(into) {
  const papers = el('div', 'papers');
  [['auto', 'themeAuto'], ['light', 'themeLight'], ['sepia', 'themeSepia'], ['dark', 'themeDark'], ['black', 'themeBlack']]
    .forEach(([id, key]) => {
      const b = el('button', 'paper' + (state.theme === id ? ' on' : ''),
        `<span class="sw p-${id}">Аа</span><small>${escapeHtml(t(key))}</small>`);
      b.dataset.v = id;
      b.onclick = () => {
        state.theme = id; ls.set('set:theme', id); applyTheme();
        papers.querySelectorAll('.paper').forEach(x => x.classList.toggle('on', x === b));
      };
      papers.appendChild(b);
    });
  into.appendChild(papers);
}

export function drawerView(body) {
  const again = () => { body.innerHTML = ''; drawerView(body); };
  const sec = (cap, cls) => {
    const s = el('section', 'vw' + (cls ? ' ' + cls : ''));
    if (cap) s.appendChild(el('div', 'cap', escapeHtml(cap)));
    body.appendChild(s);
    return s;
  };
  const seg = (opts, cur, on) => {
    const s = el('div', 'seg');
    opts.forEach(([v, label, icon]) => {
      const b = el('button', v === cur ? 'on' : '', icon ? svg(ICON[icon]) : escapeHtml(label));
      if (icon) { b.title = label; b.setAttribute('aria-label', label); }
      b.dataset.v = v;
      b.onclick = () => {
        s.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        on(v);
      };
      s.appendChild(b);
    });
    return s;
  };
  const row = (label, hint, control) => {
    const r = el('div', 'setrow');
    const l = el('div'); l.appendChild(el('div', 'lbl', escapeHtml(label)));
    if (hint) l.appendChild(el('div', 'hint', escapeHtml(hint)));
    r.appendChild(l); r.appendChild(control); body.appendChild(r);
    return r;
  };

  themePicker(sec(t('theme')));

  // PDF свёрстан навсегда: кегль, поля и разметку задаёт сам файл, крутить нечего.
  if (state.kind === 'pdf') {
    body.appendChild(el('div', 'empty', t('pdfFixed')));
    return;
  }
  const T = state.type;

  const faceSec = sec(t('typeface'));
  const grid = el('div', 'faces');
  Object.entries(FONTS).forEach(([id, f]) => {
    const name = f.name || t(id === 'original' ? 'fontOriginal' : 'fontSystem');
    const b = el('button', 'face' + (T.font === id ? ' on' : ''),
      `<span class="aa">${id === 'original' ? svg(ICON.book) : 'Аа'}</span><small>${escapeHtml(name)}</small>`);
    b.dataset.v = id;
    if (id !== 'original') b.querySelector('.aa').style.fontFamily = stackOf(f);
    b.onclick = async () => {
      grid.querySelectorAll('.face').forEach(x => x.classList.toggle('on', x === b));
      T.font = id; saveType();
      await fontReady(id);
      if (T.font !== id) return;          // пока грузилась, выбрали другую
      applyType(); settle();
      weightRow.hidden = !fontOf(id).w;
      if (fontOf(id).w) tuneWeight();
    };
    grid.appendChild(b);
    // Образец рисуется своей гарнитурой — подтягиваем её, когда плитка показана.
    if (f.css) loadFaces(id).catch(() => {});
  });
  faceSec.appendChild(grid);

  /* Ползунок: правка видна сразу, а перекладка страницы ждёт, пока рука остановится. */
  const sliders = sec(null, 'sliders');
  const slider = (key, icon, { min, max, step, get, set, fmt, save }) => {
    const r = el('label', 'sl');
    r.innerHTML = `<span class="ic">${icon}</span><input type="range" class="rng" aria-label="${escapeHtml(t(key))}">`
      + `<span class="val"></span><span class="nm">${escapeHtml(t(key))}</span>`;
    const input = r.querySelector('input'), val = r.querySelector('.val');
    const paint = () => {
      val.textContent = fmt(+input.value);
      input.style.setProperty('--p', ((input.value - input.min) / (input.max - input.min) * 100) + '%');
    };
    const range = (lo, hi) => { input.min = lo; input.max = hi; input.step = step; input.value = get(); paint(); };
    range(min, max);
    input.dataset.k = key;
    input.oninput = () => { set(+input.value); paint(); applyType(); settle(); };
    input.onchange = save;
    sliders.appendChild(r);
    return { row: r, range };
  };
  slider('fontSize', '<b class="a-s">A</b>', {
    min: 70, max: 200, step: 2, get: () => state.fontSize, set: v => { state.fontSize = v; },
    fmt: v => v + '%', save: () => ls.set('set:font', state.fontSize) });
  slider('lineHeight', svg(ICON.lh), {
    min: 1.2, max: 2, step: 0.05, get: () => T.lh, set: v => { T.lh = v; },
    fmt: v => v.toFixed(2).replace('.', t('decimal')), save: saveType });
  const weight = slider('weight', svg(ICON.weight), {
    min: 300, max: 700, step: 25, get: () => T.weight, set: v => { T.weight = v; },
    fmt: v => String(v), save: saveType });
  const weightRow = weight.row;
  // Диапазон насыщенности у гарнитур разный; у невариативных ползунка нет вовсе.
  const tuneWeight = () => {
    const [lo, hi] = fontOf(T.font).w;
    T.weight = Math.max(lo, Math.min(hi, T.weight));
    weight.range(lo, hi);
  };
  weightRow.hidden = !fontOf(T.font).w;
  if (fontOf(T.font).w) tuneWeight();
  slider('tracking', svg(ICON.track), {
    min: -2, max: 8, step: 1, get: () => T.track, set: v => { T.track = v; },
    fmt: v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + '%', save: saveType });

  const live = (key, v) => { T[key] = v; saveType(); applyType(); settle(); };
  row(t('align'), null, seg([['justify', t('alignJustify'), 'justify'], ['left', t('alignLeft'), 'left']],
    T.align, v => live('align', v))).dataset.k = 'align';
  row(t('paragraphs'), t('paragraphsHint'),
    seg([['book', t('paraBook'), 'book'], ['indent', t('paraIndent'), 'indent'], ['gap', t('paraGap'), 'gap']],
      T.para, v => live('para', v))).dataset.k = 'para';
  const sw = el('button', 'switch' + (T.hyph ? ' on' : ''));
  sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(T.hyph));
  sw.setAttribute('aria-label', t('hyphens'));
  sw.onclick = () => {
    live('hyph', !T.hyph);
    sw.classList.toggle('on', T.hyph); sw.setAttribute('aria-checked', String(T.hyph));
  };
  row(t('hyphens'), t('hyphensHint'), sw).dataset.k = 'hyph';

  /* Поля, разметка и разворот меняют саму сетку страницы — книга пересобирается. */
  const rebuild = (key, store) => v => { state[key] = v; ls.set(store, v); reopen(); };
  row(t('margins'), t('marginsHint'),
    seg([['narrow', t('marginNarrow')], ['normal', t('marginNormal')], ['wide', t('marginWide')]],
      state.margin, rebuild('margin', 'set:margin'))).dataset.k = 'margin';
  row(t('layout'), t('layoutHint'),
    seg([['paginated', t('layoutPaged')], ['scrolled', t('layoutScrolled')]],
      state.flow, rebuild('flow', 'set:flow'))).dataset.k = 'flow';
  row(t('spread'), t('spreadHint'),
    seg([['auto', t('spreadAuto')], ['single', t('spreadSingle')]],
      state.spread, rebuild('spread', 'set:spread'))).dataset.k = 'spread';

  const reset = el('button', 'chip', escapeHtml(t('resetView')));
  reset.id = 'viewReset';
  reset.onclick = () => {
    state.type = { ...TYPE_DEFAULTS }; saveType();
    state.fontSize = SIZE_DEFAULT; ls.set('set:font', SIZE_DEFAULT);
    const grid0 = state.margin !== 'normal';
    state.margin = 'normal'; ls.set('set:margin', 'normal');
    again();
    if (grid0) return reopen();
    applyType(); settle();
  };
  const foot = el('div', 'vw-foot');
  foot.appendChild(reset);
  body.appendChild(foot);
}
