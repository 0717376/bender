import { auth, showAuth } from './auth.js'
import { $, COLORS, colorName, colorOf, el, escapeHtml, ls, state, toast, when } from './core.js'
import { PROMPT, lang, plural, setLang, t } from './i18n.js'
import { redrawHighlights } from './highlights.js'
import { applyTheme, findInBook, fitLines, flashFind, jumpTo, relayoutNow, reopen, windowSig } from './reader.js'
import { chips, inline, openHighlight, openSheet, resetScrim, send, sheet, sheetHead } from './sheet.js'
import { buildShelf } from './shelf.js'
import { live, sync } from './sync.js'

/* ── Ящики ── */

const THEMES = () => [['auto', t('themeAuto')], ['light', t('themeLight')],
                      ['sepia', t('themeSepia')], ['dark', t('themeDark')]];

export function openDrawer(title, build, action) {
  $('#drawerTitle').textContent = title;
  const act = $('#drawerAct');
  act.style.display = 'none'; act.onclick = null;
  if (action) {
    act.style.display = '';
    act.innerHTML = `<svg class="icon"><use href="#${action.icon}"/></svg>`;
    act.title = action.title;
    act.onclick = action.run;
  }
  const body = $('#drawerBody'); body.innerHTML = '';
  build(body);
  resetScrim();
  $('#drawer').classList.add('on'); $('#scrim').classList.add('on');
  drawerWin = windowSig();
}
let drawerWin = null;      // каким было окно, когда ящик открылся
export function closeDrawer() {
  $('#drawer').classList.remove('on'); $('#scrim').classList.remove('on');
  // Пока ящик был открыт, окно могла сжимать клавиатура поиска — раскладка ждала закрытия.
  // Подгоняем только если окно и правда менялось: зря пересобирать — дёргать страницу.
  if (drawerWin !== null && windowSig() !== drawerWin && document.documentElement.classList.contains('reading')) relayoutNow();
  drawerWin = null;
}

export function drawerToc(body) {
  if (state.kind === 'pdf') {
    const here = $('#chapLabel').textContent.trim();
    (state.pdf.outline || []).forEach(i => {
      const b = el('button', 'item' + (i.title === here ? ' cur' : ''));
      b.innerHTML = `<div class="s ${i.lvl ? 'toc-l2' : 'toc-l1'}">${escapeHtml(i.title)}</div><div class="m">${escapeHtml(t('pageNo', i.page))}</div>`;
      b.onclick = () => { state.pdf.goto(i.page); closeDrawer(); };
      body.appendChild(b);
    });
    if (!(state.pdf.outline || []).length) body.appendChild(el('div', 'empty', t('noToc')));
    return;
  }
  const toc = (state.book.navigation && state.book.navigation.toc) || [];
  const here = $('#chapLabel').textContent.trim();
  const add = (items, lvl) => items.forEach(i => {
    const label = (i.label || '').trim();
    const b = el('button', 'item' + (label && label === here ? ' cur' : ''));
    b.innerHTML = `<div class="s ${lvl === 0 ? 'toc-l1' : 'toc-l2'}">${escapeHtml(label)}</div>`;
    b.onclick = () => { jumpTo(i.href); closeDrawer(); };
    body.appendChild(b);
    if (i.subitems && i.subitems.length) add(i.subitems, lvl + 1);
  });
  add(toc, 0);
  if (!toc.length) body.appendChild(el('div', 'empty', t('noToc')));
}

export function drawerFind(body) {
  const box = el('div', 'findbox');
  const input = el('input');
  input.type = 'search'; input.placeholder = t('findInBook'); input.autocomplete = 'off';
  box.appendChild(input);
  body.appendChild(box);
  const out = el('div');
  body.appendChild(out);

  let gen = 0, timer = null;
  const run = async q => {
    const mine = ++gen;
    out.innerHTML = '';
    if (q.length < 3) {
      if (q) out.appendChild(el('div', 'empty', t('atLeastThree')));
      return;
    }
    out.appendChild(el('div', 'empty', t('searching')));
    const pdf = state.kind === 'pdf';
    const hits = pdf ? await state.pdf.search(q, () => gen !== mine)
      : await findInBook(q, () => gen !== mine);
    if (gen !== mine) return;                    // пока искали, запрос сменился
    out.innerHTML = '';
    if (!hits.length) { out.appendChild(el('div', 'empty', t('nothingFound'))); return; }
    out.appendChild(el('div', 'empty', plural(hits.length, 'finds')));
    hits.forEach(h => {
      const b = el('button', 'item');
      const text = (h.excerpt || '').trim();
      const at = text.toLowerCase().indexOf(q.toLowerCase());
      const where = pdf ? [t('pageNo', h.page), state.pdf.labelAt(h.page)].filter(Boolean).join(' · ')
        : h.chapter || '';
      b.innerHTML = `<div class="s">${at < 0 ? escapeHtml(text)
        : escapeHtml(text.slice(0, at)) + '<mark>' + escapeHtml(text.slice(at, at + q.length))
          + '</mark>' + escapeHtml(text.slice(at + q.length))}</div>
        ${where ? `<div class="m">${escapeHtml(where)}</div>` : ''}`;
      b.onclick = async () => {
        closeDrawer();
        if (pdf) return state.pdf.goto(h.page);
        await jumpTo(h.cfi);
        flashFind(h.cfi);
      };
      out.appendChild(b);
    });
  };

  input.oninput = () => { clearTimeout(timer); timer = setTimeout(() => run(input.value.trim()), 350); };
  input.onkeydown = e => { if (e.key === 'Enter') { clearTimeout(timer); run(input.value.trim()); } };
  setTimeout(() => input.focus(), 260);
}

export function drawerHighlights(body) {
  if (!live().length) {
    body.appendChild(el('div', 'empty', t('noHighlightsYet')));
    return;
  }
  const filter = el('div', 'chips');
  let active = null;
  const render = () => {
    [...body.querySelectorAll('.item')].forEach(n => n.remove());
    live().filter(h => !active || h.color === active).sort((a, b) => b.ts - a.ts).forEach(h => {
      const b = el('button', 'item');
      const talk = (h.thread || []).filter(t => t.role === 'ai').length;
      b.innerHTML = `<div class="s">${escapeHtml(h.text.slice(0, 200))}${h.text.length > 200 ? '…' : ''}</div>
        ${h.note ? `<div class="note-line"><svg class="icon"><use href="#i-note"/></svg>${escapeHtml(h.note)}</div>` : ''}
        <div class="m"><i style="background:${colorOf(h.color).hex}"></i>${escapeHtml(colorName(h.color))}
        ${h.chapter ? ' · ' + escapeHtml(h.chapter) : ''}${talk ? ' · ' + escapeHtml(t('agentReplies', plural(talk, 'replies'))) : ''}</div>`;
      b.onclick = () => { jumpTo(h.cfi); closeDrawer(); setTimeout(() => openHighlight(h), 400); };
      body.appendChild(b);
    });
  };
  COLORS.forEach(c => {
    const chip = el('button', 'chip');
    chip.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.hex}"></span>${escapeHtml(t(c.key))}`;
    chip.onclick = () => { active = active === c.id ? null : c.id; render(); };
    filter.appendChild(chip);
  });
  body.appendChild(filter);
  render();
}

export function allToWiki() {
  if (!live().length) return toast(t('noHighlights'));
  if (!auth.token) return showAuth(t('signInToWiki'));
  const m = state.meta || {};
  const lines = live().slice().sort((a, b) => a.ts - b.ts).map(h => {
    const talk = (h.thread || []).map(m => (m.role === 'me' ? PROMPT.me : PROMPT.agentSaid) + m.text).join('\n');
    return `— ${colorName(h.color)}${h.chapter ? ', ' + h.chapter : ''}\n«${h.text}»`
      + (h.note ? '\n' + PROMPT.myNoteInline(h.note) : '') + (talk ? '\n' + talk : '');
  }).join('\n\n');
  closeDrawer();
  const h = { text: PROMPT.allHighlights, chapter: '', thread: [] };
  state.active = h; sheet.kind = 'wiki';
  sheetHead('wiki', h);
  $('#sheetQuote').textContent = PROMPT.fromBook(plural(live().length, 'highlights'));
  $('#sheetBody').innerHTML = '';
  chips([]);
  openSheet();
  send([
    PROMPT.collectPage(m.title || state.entry.title || '', m.creator || ''),
    '', PROMPT.myHighlights, lines, '', PROMPT.groupThem,
  ].join('\n'));
}

export function drawerSettings(body) {
  const row = (label, hint, control) => {
    const r = el('div', 'setrow');
    const l = el('div'); l.appendChild(el('div', 'lbl', label));
    if (hint) l.appendChild(el('div', 'hint', hint));
    r.appendChild(l); r.appendChild(control); body.appendChild(r);
  };
  const seg = (opts, cur, on) => {
    const s = el('div', 'seg');
    opts.forEach(([v, t]) => { const b = el('button', v === cur ? 'on' : '', t); b.onclick = () => on(v); s.appendChild(b); });
    return s;
  };
  row(t('theme'), null, seg(THEMES(), state.theme, v => {
    state.theme = v; ls.set('set:theme', v); applyTheme();
    closeDrawer(); openDrawer(t('viewTitle'), drawerSettings);
  }));
  // PDF свёрстан навсегда: кегль, поля и разметку задаёт сам файл, крутить нечего.
  if (state.kind === 'pdf') {
    body.appendChild(el('div', 'empty', t('pdfFixed')));
    return;
  }
  const sizes = el('div', 'seg');
  [['A−', -8], ['A+', 8]].forEach(([t, d]) => {
    const b = el('button', '', t);
    b.onclick = () => {
      state.fontSize = Math.max(70, Math.min(190, state.fontSize + d));
      ls.set('set:font', state.fontSize);
      state.rendition.themes.fontSize(state.fontSize + '%');
      // Строка стала другой высоты — подгонка съехала, а метки выписок остались от старой раскладки.
      setTimeout(async () => { await fitLines(); redrawHighlights(); }, 140);
      const lbl = body.querySelector('#fsz'); if (lbl) lbl.textContent = state.fontSize + '%';
    };
    sizes.appendChild(b);
  });
  row(t('fontSize'), null, sizes);
  const cur = body.lastElementChild.querySelector('.lbl');
  cur.innerHTML = escapeHtml(t('fontSize'))
    + ' <span id="fsz" style="color:var(--text-3)">' + state.fontSize + '%</span>';
  row(t('margins'), t('marginsHint'),
    seg([['narrow', t('marginNarrow')], ['normal', t('marginNormal')], ['wide', t('marginWide')]], state.margin, v => {
      state.margin = v; ls.set('set:margin', v); closeDrawer(); reopen();
    }));
  row(t('layout'), t('layoutHint'),
    seg([['paginated', t('layoutPaged')], ['scrolled', t('layoutScrolled')]], state.flow, v => {
      state.flow = v; ls.set('set:flow', v); closeDrawer(); reopen();
    }));
  row(t('spread'), t('spreadHint'),
    seg([['auto', t('spreadAuto')], ['single', t('spreadSingle')]], state.spread, v => {
      state.spread = v; ls.set('set:spread', v); closeDrawer(); reopen();
    }));
}

export function drawerPrefs(body) {
  const row = (label, hint, control) => {
    const r = el('div', 'setrow');
    const l = el('div'); l.appendChild(el('div', 'lbl', label));
    if (hint) l.appendChild(el('div', 'hint', hint));
    r.appendChild(l); r.appendChild(control); body.appendChild(r);
  };
  const seg = (opts, cur, on) => {
    const s = el('div', 'seg');
    opts.forEach(([v, t]) => { const b = el('button', v === cur ? 'on' : '', t); b.onclick = () => on(v); s.appendChild(b); });
    return s;
  };
  row(t('theme'), null, seg(THEMES(), state.theme, v => {
    state.theme = v; ls.set('set:theme', v); applyTheme();
    closeDrawer(); openDrawer(t('settings'), drawerPrefs);
  }));
  // Язык интерфейса: по умолчанию берётся из браузера, здесь его можно закрепить.
  row(t('language'), null, seg([['ru', 'Русский'], ['en', 'English']], lang, v => {
    if (v !== lang) setLang(v);
  }));
  const now = el('button', 'chip');
  now.textContent = t('syncNow');
  now.onclick = async () => {
    now.textContent = t('syncing');
    const ok = await sync.run({ force: true });
    now.textContent = t('syncNow');
    toast(ok ? t('syncOk') : t('syncFailed'));
    if (ok) { buildShelf(); closeDrawer(); }
  };
  row(t('progress'), sync.last ? t('syncedAt', when(sync.last)) : t('neverSynced'), now);

  const out = el('button', 'chip');
  out.innerHTML = '<svg class="icon"><use href="#i-out"/></svg>' + escapeHtml(t('signOut'));
  out.onclick = () => { auth.forget(); location.reload(); };
  row(t('agent'), auth.token ? t('signedIn') : t('signedOut'), out);
  const info = el('div', 'empty');
  info.innerHTML = t('storageNote');
  body.appendChild(info);
}
