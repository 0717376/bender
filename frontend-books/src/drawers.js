import { auth, showAuth } from './auth.js'
import { $, COLORS, colorOf, el, escapeHtml, ls, plural, state, toast, when } from './core.js'
import { applyTheme, findInBook, fitLines, flashFind, reopen } from './reader.js'
import { chips, inline, openHighlight, openSheet, resetScrim, send, sheet, sheetHead } from './sheet.js'
import { buildShelf } from './shelf.js'
import { live, sync } from './sync.js'

/* ── Ящики ── */

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
}
export function closeDrawer() { $('#drawer').classList.remove('on'); $('#scrim').classList.remove('on'); }

export function drawerToc(body) {
  const toc = (state.book.navigation && state.book.navigation.toc) || [];
  const here = $('#chapLabel').textContent.trim();
  const add = (items, lvl) => items.forEach(i => {
    const label = (i.label || '').trim();
    const b = el('button', 'item' + (label && label === here ? ' cur' : ''));
    b.innerHTML = `<div class="s ${lvl === 0 ? 'toc-l1' : 'toc-l2'}">${escapeHtml(label)}</div>`;
    b.onclick = () => { state.rendition.display(i.href); closeDrawer(); };
    body.appendChild(b);
    if (i.subitems && i.subitems.length) add(i.subitems, lvl + 1);
  });
  add(toc, 0);
  if (!toc.length) body.appendChild(el('div', 'empty', 'В книге нет оглавления'));
}

export function drawerFind(body) {
  const box = el('div', 'findbox');
  const input = el('input');
  input.type = 'search'; input.placeholder = 'Искать в книге'; input.autocomplete = 'off';
  box.appendChild(input);
  body.appendChild(box);
  const out = el('div');
  body.appendChild(out);

  let gen = 0, timer = null;
  const run = async q => {
    const mine = ++gen;
    out.innerHTML = '';
    if (q.length < 3) {
      if (q) out.appendChild(el('div', 'empty', 'Хотя бы три буквы'));
      return;
    }
    out.appendChild(el('div', 'empty', 'Ищу по книге…'));
    const hits = await findInBook(q, () => gen !== mine);
    if (gen !== mine) return;                    // пока искали, запрос сменился
    out.innerHTML = '';
    if (!hits.length) { out.appendChild(el('div', 'empty', 'Ничего не нашлось')); return; }
    out.appendChild(el('div', 'empty', plural(hits.length, 'находка', 'находки', 'находок')));
    hits.forEach(h => {
      const b = el('button', 'item');
      const text = (h.excerpt || '').trim();
      const at = text.toLowerCase().indexOf(q.toLowerCase());
      b.innerHTML = `<div class="s">${at < 0 ? escapeHtml(text)
        : escapeHtml(text.slice(0, at)) + '<mark>' + escapeHtml(text.slice(at, at + q.length))
          + '</mark>' + escapeHtml(text.slice(at + q.length))}</div>
        ${h.chapter ? `<div class="m">${escapeHtml(h.chapter)}</div>` : ''}`;
      b.onclick = async () => {
        closeDrawer();
        await state.rendition.display(h.cfi);
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
    body.appendChild(el('div', 'empty', 'Пока пусто.<br>Выдели фрагмент в тексте и выбери цвет.'));
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
        <div class="m"><i style="background:${colorOf(h.color).hex}"></i>${escapeHtml(colorOf(h.color).name)}
        ${h.chapter ? ' · ' + escapeHtml(h.chapter) : ''}${talk ? ' · ' + plural(talk, 'ответ', 'ответа', 'ответов') + ' агента' : ''}</div>`;
      b.onclick = () => { state.rendition.display(h.cfi); closeDrawer(); setTimeout(() => openHighlight(h), 400); };
      body.appendChild(b);
    });
  };
  COLORS.forEach(c => {
    const chip = el('button', 'chip');
    chip.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.hex}"></span>${c.name}`;
    chip.onclick = () => { active = active === c.id ? null : c.id; render(); };
    filter.appendChild(chip);
  });
  body.appendChild(filter);
  render();
}

export function allToWiki() {
  if (!live().length) return toast('Выписок пока нет');
  if (!auth.token) return showAuth('Войди, чтобы отправить в вики');
  const m = state.meta || {};
  const lines = live().slice().sort((a, b) => a.ts - b.ts).map(h => {
    const talk = (h.thread || []).map(t => (t.role === 'me' ? 'Я: ' : 'Агент: ') + t.text).join('\n');
    return `— ${colorOf(h.color).name}${h.chapter ? ', ' + h.chapter : ''}\n«${h.text}»`
      + (h.note ? `\nМоя заметка: ${h.note}` : '') + (talk ? '\n' + talk : '');
  }).join('\n\n');
  closeDrawer();
  const h = { text: 'Все выписки из книги', chapter: '', thread: [] };
  state.active = h; sheet.kind = 'wiki';
  sheetHead('wiki', h);
  $('#sheetQuote').textContent = plural(live().length, 'выписка', 'выписки', 'выписок') + ' из книги';
  $('#sheetBody').innerHTML = '';
  chips([]);
  openSheet();
  send([
    `Собери страницу в вики по книге «${m.title || state.entry.title || ''}»`
      + (m.creator ? ` (${m.creator})` : '') + '.',
    '', 'Мои выписки:', lines, '',
    'Сгруппируй по смыслу, а не по цвету, добавь короткое вступление своими словами и '
      + 'ответь одной строкой — куда положил.',
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
  row('Тема', null, seg([['auto', 'Как в системе'], ['light', 'Светлая'], ['sepia', 'Сепия'], ['dark', 'Тёмная']],
    state.theme, v => {
      state.theme = v; ls.set('set:theme', v); applyTheme();
      closeDrawer(); openDrawer('Вид', drawerSettings);
    }));
  const sizes = el('div', 'seg');
  [['A−', -8], ['A+', 8]].forEach(([t, d]) => {
    const b = el('button', '', t);
    b.onclick = () => {
      state.fontSize = Math.max(70, Math.min(190, state.fontSize + d));
      ls.set('set:font', state.fontSize);
      state.rendition.themes.fontSize(state.fontSize + '%');
      setTimeout(fitLines, 140);        // строка стала другой высоты — подгонка съехала
      const lbl = body.querySelector('#fsz'); if (lbl) lbl.textContent = state.fontSize + '%';
    };
    sizes.appendChild(b);
  });
  row('Кегль', null, sizes);
  const cur = body.lastElementChild.querySelector('.lbl');
  cur.innerHTML = 'Кегль <span id="fsz" style="color:var(--text-3)">' + state.fontSize + '%</span>';
  row('Разметка', 'страницами — как в бумажной книге; лентой — как в вебе',
    seg([['paginated', 'Страницы'], ['scrolled', 'Лента']], state.flow, v => {
      state.flow = v; ls.set('set:flow', v); closeDrawer(); reopen();
    }));
  row('Разворот', 'на широком экране — две страницы',
    seg([['auto', 'Авто'], ['single', 'Одна']], state.spread, v => {
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
  row('Тема', null, seg([['auto', 'Как в системе'], ['light', 'Светлая'], ['sepia', 'Сепия'], ['dark', 'Тёмная']],
    state.theme, v => {
      state.theme = v; ls.set('set:theme', v); applyTheme();
      closeDrawer(); openDrawer('Настройки', drawerPrefs);
    }));
  const now = el('button', 'chip');
  now.textContent = 'Синхронизировать';
  now.onclick = async () => {
    now.textContent = 'Синхронизирую…';
    const ok = await sync.run({ force: true });
    now.textContent = 'Синхронизировать';
    toast(ok ? 'Прогресс сведён' : 'Не вышло — нет связи');
    if (ok) { buildShelf(); closeDrawer(); }
  };
  row('Прогресс', sync.last ? 'сведён ' + when(sync.last) : 'пока не сводился', now);

  const out = el('button', 'chip');
  out.innerHTML = '<svg class="icon"><use href="#i-out"/></svg>Выйти';
  out.onclick = () => { auth.forget(); location.reload(); };
  row('Агент', auth.token ? 'вошли, вопросы к агенту работают' : 'не вошли — агент недоступен', out);
  const info = el('div', 'empty');
  info.innerHTML = 'Файлы книг лежат на этом устройстве.<br>'
    + 'Позиция и выписки сводятся через сервер — на всех устройствах одно место в книге.';
  body.appendChild(info);
}
