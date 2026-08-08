import { agent } from './agent.js'
import { auth, showAuth } from './auth.js'
import { $, COLORS, colorOf, el, escapeHtml, state, toast } from './core.js'
import { closeDrawer } from './drawers.js'
import { ACTS, drawHighlight, hideSelbar, save, touch } from './highlights.js'
import { relayoutNow, windowSig } from './reader.js'
import { sel } from './selection.js'
import { live } from './sync.js'

/* ── Шторка агента ── */

export const CHIPS = {
  translate: ['Проще', 'Дословно', 'Разбери термины'],
  explain: ['Пример', 'Короче', 'А контраргумент?'],
  ask: ['Подробнее', 'Где ещё об этом', 'Не согласен'],
};
export const TITLES = { translate: 'Перевод', explain: 'Объяснение', ask: 'Вопрос', wiki: 'В вики' };

/** Текст вокруг выделения — агенту нужен абзац-другой, иначе он гадает по одной фразе. */
export async function contextAround(cfi, before = 900, after = 900) {
  try {
    const range = await state.book.getRange(cfi);
    if (!range) return '';
    const doc = range.startContainer.ownerDocument;
    const root = doc.body || doc.documentElement;
    const walk = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let all = '', start = -1, end = -1, node;
    while ((node = walk.nextNode())) {
      if (node === range.startContainer) start = all.length + range.startOffset;
      if (node === range.endContainer) end = all.length + range.endOffset;
      all += node.textContent;
    }
    if (start < 0) return '';
    if (end < 0) end = start;
    return all.slice(Math.max(0, start - before), Math.min(all.length, end + after))
      .replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

export function promptFor(kind, h, around, question) {
  const m = state.meta || {};
  const where = `Я читаю книгу «${m.title || state.entry.title || ''}»`
    + (m.creator ? ` (${m.creator})` : '')
    + (h.chapter ? `, глава «${h.chapter}»` : '') + '.';
  const task = {
    translate: 'Переведи выделенный фрагмент на русский. Только перевод, без вступлений и без пояснений.',
    explain: 'Объясни выделенный фрагмент: что автор имеет в виду, зачем это здесь, к чему ведёт. '
      + 'Коротко — два-три абзаца, без пересказа очевидного.',
    ask: question || 'Что скажешь про этот фрагмент?',
  }[kind];
  return [
    where, '', task, '',
    'Выделенный фрагмент:', '<<<', h.text, '>>>',
    around ? '\nТекст вокруг — для контекста, отвечать по нему не надо:\n<<<\n' + around + '\n>>>' : '',
    '', 'Ответь по-русски, без предисловий.',
  ].filter(x => x !== null).join('\n');
}

export function wikiPrompt(h) {
  const m = state.meta || {};
  const talk = (h.thread || []).map(t => (t.role === 'me' ? 'Я: ' : 'Ты: ') + t.text).join('\n\n');
  return [
    `Сохрани выписку из книги «${m.title || state.entry.title || ''}»`
      + (m.creator ? ` (${m.creator})` : '') + (h.chapter ? `, глава «${h.chapter}»` : '') + '.',
    '', 'Цитата:', '<<<', h.text, '>>>',
    h.note ? '\nМоя заметка к ней:\n' + h.note : '',
    talk ? '\nНаш разговор о ней:\n' + talk : '',
    '', 'Положи в подходящую страницу вики (или заведи новую про эту книгу), '
      + 'оформи цитату аккуратно и ответь одной строкой — куда положил.',
  ].join('\n');
}

export const sheet = { msgs: null, order: [], busy: false, kind: 'ask', waiting: null };

/* Затемнение закрывается только своим жестом: у клика, прилетевшего после тапа по книге,
   нет предшествующего нажатия на затемнение — значит, закрывать им нечего. */
export let scrimLive = false;
export function resetScrim() { scrimLive = false; }

/** Затемнение слушаем здесь же: клик по нему — единственный способ закрыть панель мимо кнопок. */
export function wireScrim() {
  ['pointerdown', 'touchstart'].forEach(ev =>
    $('#scrim').addEventListener(ev, () => { scrimLive = true; }, { passive: true }));
  $('#scrim').onclick = () => {
    if (!scrimLive) return;
    resetScrim();
    closeSheet(); closeDrawer();
  };
}

let sheetWin = null;      // каким было окно, когда шторка открылась

export function openSheet() {
  resetScrim(); $('#sheet').classList.add('on'); $('#scrim').classList.add('on');
  sheetWin = windowSig();
}
export function closeSheet() {
  const s = $('#sheet');
  s.classList.remove('on'); $('#scrim').classList.remove('on');
  s.style.bottom = ''; s.style.maxHeight = '';
  sheet.busy = false;
  // Пока шторка была открыта, окно могло измениться (клавиатура, поворот) — раскладку
  // книги мы это время сознательно не трогали, теперь подгоняем одним разом. Но только
  // если окно и правда другое: пересборка на каждом закрытии дёргает страницу зря.
  if (sheetWin !== null && windowSig() !== sheetWin && document.documentElement.classList.contains('reading')) {
    window.scrollTo(0, 0);
    relayoutNow();
  }
  sheetWin = null;
}

/* ── Клавиатура ──
   Поле ввода внизу шторки: клавиатура его накрывает, и iOS в ответ панорамирует всю
   страницу — книга за шторкой «уезжает наверх». Вместо этого шторку поднимаем сами,
   ровно на высоту клавиатуры, а панорамирование откатываем. */
export function wireSheetKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const fit = () => {
    const s = $('#sheet');
    if (!s.classList.contains('on')) return;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    s.style.bottom = kb > 0 ? kb + 'px' : '';
    s.style.maxHeight = kb > 0 ? Math.round(vv.height * 0.92) + 'px' : '';
    if (kb > 0) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}

export function sheetHead(kind, h) {
  $('#sheetTitle').textContent = TITLES[kind] || 'Агент';
  $('#sheetQuote').textContent = h.text;
  $('#sheetInput').value = '';
  showNote(null);
}

/* ── Своя заметка ──
   Ответ агента — это разговор, а заметка — то, что человек подумал сам. Поэтому она
   отдельным полем, а не первой репликой в ветке. Пишется у сохранённой выписки:
   заметку к невыделенному фрагменту негде было бы держать. */
let noteTimer = null;

export function showNote(h) {
  const box = $('#sheetNote');
  clearTimeout(noteTimer);
  if (!h || !live().find(x => x.id === h.id)) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.value = h.note || '';
  fitNote();
  box.oninput = () => {
    fitNote();
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      if ((h.note || '') === box.value) return;
      h.note = box.value; touch(h); save();
    }, 700);
  };
  box.onblur = () => {
    clearTimeout(noteTimer);
    if ((h.note || '') === box.value) return;
    h.note = box.value; touch(h); save();
  };
}

function fitNote() {
  const box = $('#sheetNote');
  box.style.height = 'auto';
  box.style.height = Math.min(box.scrollHeight, 160) + 'px';
}

export async function askAgent(kind, question) {
  const h = state.pending || state.active;
  if (!h) return;
  if (!auth.token) return showAuth('Войди, чтобы спросить агента');
  state.active = h;
  if (!h.thread) h.thread = [];
  sheet.kind = kind;
  hideSelbar();
  sheetHead(kind, h);
  $('#sheetBody').innerHTML = '';
  renderThread(h);
  chips([]);
  openSheet();

  const q = kind === 'ask' && !question ? null : question;
  if (kind === 'ask' && !q) {
    // «Спросить» без вопроса — ждём, что напишет человек.
    $('#sheetBody').appendChild(el('div', 'tool', 'Напиши вопрос про этот фрагмент'));
    setTimeout(() => $('#sheetInput').focus(), 320);
    return;
  }
  const label = { translate: 'Переведи этот фрагмент', explain: 'Объясни этот фрагмент' }[kind] || q;
  h.thread.push({ role: 'me', text: label });
  bubbleMe(label);
  const around = await contextAround(h.cfi);
  send(promptFor(kind, h, around, q));
}

export function renderThread(h) {
  const body = $('#sheetBody');
  (h.thread || []).forEach(t => {
    if (t.role === 'me') body.appendChild(el('div', 'me', escapeHtml(t.text)));
    else body.appendChild(el('div', 'ai', md(t.text)));
  });
  body.scrollTop = body.scrollHeight;
}

export function bubbleMe(text) {
  const body = $('#sheetBody');
  body.appendChild(el('div', 'me', escapeHtml(text)));
  body.scrollTop = body.scrollHeight;
}

export async function send(text) {
  const body = $('#sheetBody');
  sheet.busy = true; sheet.msgs = new Map(); sheet.order = [];
  agent.busy = true;
  $('#sheetSend').disabled = true;
  sheet.waiting = el('div', 'tool', '<span class="spin"></span>думает…');
  body.appendChild(sheet.waiting);
  body.scrollTop = body.scrollHeight;
  try {
    await agent.send(text, { book: bookInfo() });
  } catch (e) {
    finishTurn();
    body.appendChild(el('div', 'err', escapeHtml(e.message || 'Агент недоступен')));
  }
}

/* Книга уезжает агенту не названием, а id: по нему он открывает саму книгу
   (оглавление, главы, поиск), а не гадает по цитате и абзацу вокруг неё. */
export function bookInfo() {
  const m = state.meta || {}, e = state.entry || {};
  const h = state.active || state.pending || {};
  return {
    id: e.id || '',
    title: m.title || e.title || '',
    author: m.creator || '',
    chapter: h.chapter || $('#chapLabel').textContent || '',
  };
}

agent.onEvent = ev => {
  const body = $('#sheetBody');
  if (ev.t === 'text') {
    if (sheet.waiting) { sheet.waiting.remove(); sheet.waiting = null; }
    let node = sheet.msgs && sheet.msgs.get(ev.id);
    if (!node) {
      node = el('div', 'ai');
      body.appendChild(node);
      const first = !sheet.order.length;
      if (sheet.msgs) { sheet.msgs.set(ev.id, node); sheet.order.push(ev.id); }
      // Начало ответа — к верхнему краю шторки: читают сначала, а стриминг пусть дописывает
      // ниже сам по себе. Тянуть прокрутку за ним — значит заставлять читать с конца.
      if (first) body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - 48;
    }
    node.dataset.text = ev.text;
    node.innerHTML = md(ev.text) + (sheet.busy ? '<span class="cursor"></span>' : '');
  } else if (ev.t === 'tool') {
    if (sheet.waiting) sheet.waiting.innerHTML = '<span class="spin"></span>' + escapeHtml(toolLabel(ev));
  } else if (ev.t === 'error') {
    body.appendChild(el('div', 'err', escapeHtml(ev.text || 'Ошибка')));
    body.scrollTop = body.scrollHeight;
  } else if (ev.t === 'done') {
    finishTurn();
  }
};

export function toolLabel(ev) {
  const n = (ev.name || '').toLowerCase();
  if (n.includes('books__search')) return 'ищет по книге…';
  if (n.includes('books__read') || n.includes('books__book_chapters')) return 'читает книгу…';
  if (n.includes('books__list_highlights')) return 'смотрит выписки…';
  if (n.includes('books__list_books')) return 'смотрит полку…';
  if (n.includes('grep') || n.includes('search')) return 'ищет в вики…';
  if (n.includes('read')) return 'читает ' + (ev.file || 'страницу') + '…';
  if (n.includes('write') || n.includes('edit')) return 'пишет в вики…';
  if (n.includes('web')) return 'смотрит в интернете…';
  return 'работает…';
}

export function finishTurn() {
  sheet.busy = false; agent.busy = false;
  $('#sheetSend').disabled = false;
  if (sheet.waiting) { sheet.waiting.remove(); sheet.waiting = null; }
  const h = state.active;
  let full = '';
  if (sheet.msgs) sheet.order.forEach(id => {
    const n = sheet.msgs.get(id);
    if (n) { n.innerHTML = md(n.dataset.text || ''); full += (full ? '\n\n' : '') + (n.dataset.text || ''); }
  });
  if (h && full) {
    h.thread = h.thread || [];
    h.thread.push({ role: 'ai', text: full });
    if (live().find(x => x.id === h.id)) save();
  }
  chips(CHIPS[sheet.kind] || CHIPS.ask, true);
}

export function chips(list, withActions) {
  const box = $('#sheetChips'); box.innerHTML = '';
  list.forEach(t => {
    const c = el('button', 'chip', escapeHtml(t));
    c.onclick = () => followUp(t);
    box.appendChild(c);
  });
  if (!withActions) return;
  const h = state.active;
  if (!h) return;
  if (!live().find(x => x.id === h.id)) {
    const keep = el('button', 'chip strong', '<svg class="icon"><use href="#i-mark"/></svg>В выписки');
    keep.onclick = () => {
      h.color = h.color || 'q';
      state.hl.push(h); drawHighlight(h); save();
      showNote(h);                       // выписка появилась — есть куда писать заметку
      toast('Сохранено в выписки'); chips(list, true);
    };
    box.appendChild(keep);
  }
  const wiki = el('button', 'chip strong', '<svg class="icon"><use href="#i-wiki"/></svg>В вики');
  wiki.onclick = () => {
    if (!live().find(x => x.id === h.id)) { h.color = h.color || 'wiki'; state.hl.push(h); drawHighlight(h); save(); }
    sheet.kind = 'wiki';
    $('#sheetTitle').textContent = TITLES.wiki;
    bubbleMe('Сохрани в вики');
    h.thread.push({ role: 'me', text: 'Сохрани в вики' });
    send(wikiPrompt(h));
  };
  box.appendChild(wiki);
}

export function followUp(text) {
  if (sheet.busy) return toast('Дождись ответа');
  const h = state.active;
  if (!h) return;
  h.thread = h.thread || [];
  h.thread.push({ role: 'me', text });
  bubbleMe(text);
  $('#sheetInput').value = '';
  if (live().find(x => x.id === h.id)) save();
  send(text);
}

/** Минимальный markdown: агент отвечает списками и жирным, а не голым текстом. */
export function md(text) {
  const src = String(text || '');
  const blocks = src.split(/\n{2,}/);
  return blocks.map(b => {
    const lines = b.split('\n');
    if (/^```/.test(b)) return '<pre>' + escapeHtml(b.replace(/^```\w*\n?|```$/g, '')) + '</pre>';
    if (lines.every(l => /^\s*[-*·]\s+/.test(l) || !l.trim())) {
      const li = lines.filter(l => l.trim()).map(l => '<li>' + inline(l.replace(/^\s*[-*·]\s+/, '')) + '</li>').join('');
      return '<ul>' + li + '</ul>';
    }
    if (/^#{1,6}\s+/.test(b)) return '<b class="h">' + inline(b.replace(/^#{1,6}\s+/, '')) + '</b>';
    return '<p>' + lines.map(inline).join('<br>') + '</p>';
  }).join('');
}
export function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
}

export function openHighlight(h) {
  state.active = h; state.pending = h;
  if (!h.thread) h.thread = [];
  sheet.kind = 'ask';
  $('#sheetTitle').textContent = colorOf(h.color).name;
  $('#sheetQuote').textContent = h.text;
  showNote(h);
  $('#sheetBody').innerHTML = '';
  renderThread(h);
  const box = $('#sheetChips'); box.innerHTML = '';
  COLORS.forEach(c => {
    const d = el('button', 'dot' + (c.id === h.color ? ' sel' : '')); d.style.background = c.hex;
    d.onclick = () => {
      h.color = c.id;
      try { state.rendition.annotations.remove(h.cfi, 'highlight'); } catch {}
      drawHighlight(h); save(); openHighlight(h);
    };
    box.appendChild(d);
  });
  ACTS.forEach(a => {
    const c = el('button', 'chip', a.label);
    c.onclick = () => askAgent(a.kind);
    box.appendChild(c);
  });
  const wiki = el('button', 'chip strong', '<svg class="icon"><use href="#i-wiki"/></svg>В вики');
  wiki.onclick = () => {
    sheet.kind = 'wiki'; $('#sheetTitle').textContent = TITLES.wiki;
    bubbleMe('Сохрани в вики'); h.thread.push({ role: 'me', text: 'Сохрани в вики' });
    send(wikiPrompt(h));
  };
  box.appendChild(wiki);
  const del = el('button', 'chip', '<svg class="icon"><use href="#i-trash"/></svg>Удалить');
  del.onclick = () => {
    try { state.rendition.annotations.remove(h.cfi, 'highlight'); } catch {}
    // Не выкидываем, а помечаем: иначе удаление воскреснет со второго устройства.
    h.del = 1; touch(h);
    save(); closeSheet(); toast('Выписка удалена');
  };
  box.appendChild(del);
  openSheet();
}
