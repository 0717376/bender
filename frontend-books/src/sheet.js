import { agent } from './agent.js'
import { auth, showAuth } from './auth.js'
import { $, COLORS, colorName, el, escapeHtml, state, toast } from './core.js'
import { PROMPT, t } from './i18n.js'
import { closeDrawer } from './drawers.js'
import { ACTS, drawHighlight, eraseHighlight, hideSelbar, save, touch } from './highlights.js'
import { relayoutNow, windowSig } from './reader.js'
import { sel } from './selection.js'
import { live } from './sync.js'

/* ── Шторка агента ── */

export const CHIPS = {
  translate: t('chipsTranslate'),
  explain: t('chipsExplain'),
  ask: t('chipsAsk'),
};
export const TITLES = { translate: t('titleTranslate'), explain: t('titleExplain'),
                        ask: t('titleAsk'), wiki: t('toWiki') };

/** Текст вокруг выделения — агенту нужен абзац-другой, иначе он гадает по одной фразе. */
export async function contextAround(cfi, before = 900, after = 900) {
  // В pdf текст берётся со страницы, а не из главы: свою окрестность движок знает сам.
  if (state.kind === 'pdf') return state.pdf ? state.pdf.context(cfi, before, after) : '';
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
  const where = PROMPT.reading(m.title || state.entry.title || '', m.creator || '')
    + (h.chapter ? PROMPT.chapter(h.chapter) : '') + '.';
  const task = {
    translate: PROMPT.translate,
    explain: PROMPT.explain,
    ask: question || PROMPT.askDefault,
  }[kind];
  return [
    where, '', task, '',
    PROMPT.fragment, '<<<', h.text, '>>>',
    around ? '\n' + PROMPT.around + '\n<<<\n' + around + '\n>>>' : '',
    '', PROMPT.answerIn,
  ].filter(x => x !== null).join('\n');
}

export function wikiPrompt(h) {
  const m = state.meta || {};
  const talk = (h.thread || []).map(m => (m.role === 'me' ? PROMPT.me : PROMPT.you) + m.text).join('\n\n');
  return [
    PROMPT.saveQuote(m.title || state.entry.title || '', m.creator || '')
      + (h.chapter ? PROMPT.chapter(h.chapter) : '') + '.',
    '', PROMPT.quote, '<<<', h.text, '>>>',
    h.note ? '\n' + PROMPT.myNote + '\n' + h.note : '',
    talk ? '\n' + PROMPT.ourTalk + '\n' + talk : '',
    '', PROMPT.putInWiki,
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
  $('#sheetTitle').textContent = TITLES[kind] || t('agent');
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
  if (!auth.token) return showAuth(t('signInToAsk'));
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
    $('#sheetBody').appendChild(el('div', 'tool', t('askAboutFragment')));
    setTimeout(() => $('#sheetInput').focus(), 320);
    return;
  }
  const label = { translate: PROMPT.askLabelTranslate, explain: PROMPT.askLabelExplain }[kind] || q;
  h.thread.push({ role: 'me', text: label });
  bubbleMe(label);
  const around = await contextAround(h.cfi);
  send(promptFor(kind, h, around, q));
}

export function renderThread(h) {
  const body = $('#sheetBody');
  (h.thread || []).forEach(m => {
    if (m.role === 'me') body.appendChild(el('div', 'me', escapeHtml(m.text)));
    else body.appendChild(el('div', 'ai', md(m.text)));
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
  sheet.waiting = el('div', 'tool', '<span class="spin"></span>' + escapeHtml(t('thinking')));
  body.appendChild(sheet.waiting);
  body.scrollTop = body.scrollHeight;
  try {
    await agent.send(text, { book: bookInfo() });
  } catch (e) {
    finishTurn();
    body.appendChild(el('div', 'err', escapeHtml(e.message || t('agentUnavailable'))));
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
    body.appendChild(el('div', 'err', escapeHtml(ev.text || t('error'))));
    body.scrollTop = body.scrollHeight;
  } else if (ev.t === 'done') {
    finishTurn();
  }
};

export function toolLabel(ev) {
  const n = (ev.name || '').toLowerCase();
  if (n.includes('books__search')) return t('toolSearchBook');
  if (n.includes('books__read') || n.includes('books__book_chapters')) return t('toolReadBook');
  if (n.includes('books__list_highlights')) return t('toolHighlights');
  if (n.includes('books__list_books')) return t('toolShelf');
  if (n.includes('grep') || n.includes('search')) return t('toolWikiSearch');
  if (n.includes('read')) return t('toolRead', ev.file || t('toolPage'));
  if (n.includes('write') || n.includes('edit')) return t('toolWikiWrite');
  if (n.includes('web')) return t('toolWeb');
  return t('toolBusy');
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
  list.forEach(x => {
    const c = el('button', 'chip', escapeHtml(x));
    c.onclick = () => followUp(x);
    box.appendChild(c);
  });
  if (!withActions) return;
  const h = state.active;
  if (!h) return;
  if (!live().find(x => x.id === h.id)) {
    const keep = el('button', 'chip strong', '<svg class="icon"><use href="#i-mark"/></svg>' + escapeHtml(t('toHighlights')));
    keep.onclick = () => {
      h.color = h.color || 'q';
      state.hl.push(h); drawHighlight(h); save();
      showNote(h);                       // выписка появилась — есть куда писать заметку
      toast(t('savedToHighlights')); chips(list, true);
    };
    box.appendChild(keep);
  }
  const wiki = el('button', 'chip strong', '<svg class="icon"><use href="#i-wiki"/></svg>' + escapeHtml(t('toWiki')));
  wiki.onclick = () => {
    if (!live().find(x => x.id === h.id)) { h.color = h.color || 'wiki'; state.hl.push(h); drawHighlight(h); save(); }
    sheet.kind = 'wiki';
    $('#sheetTitle').textContent = TITLES.wiki;
    bubbleMe(PROMPT.saveToWiki);
    h.thread.push({ role: 'me', text: PROMPT.saveToWiki });
    send(wikiPrompt(h));
  };
  box.appendChild(wiki);
}

export function followUp(text) {
  if (sheet.busy) return toast(t('waitForAnswer'));
  const h = state.active;
  if (!h) return;
  h.thread = h.thread || [];
  h.thread.push({ role: 'me', text });
  bubbleMe(text);
  $('#sheetInput').value = '';
  if (live().find(x => x.id === h.id)) save();
  send(text);
}

/* ── Markdown ──
   Агент отвечает разметкой, и читать её решёткой и звёздочками — то же, что читать
   исходник. Разбираем построчно: заголовки, списки (в том числе нумерованные), цитаты,
   код и линейку. Вложенных списков и таблиц сознательно нет — агент их в ответах
   про книгу не пишет, а разбор от них раздувается вдвое. */

const BULLET = /^\s*[-*•·]\s+(.*)$/;
const NUMBER = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:[-*_]\s*){3,}$/;
const HEAD = /^\s*(#{1,6})\s+(.*)$/;

export function md(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const take = (re, pick) => {           // подряд идущие строки одного вида
    const got = [];
    while (i < lines.length) {
      const m = re.exec(lines[i]);
      if (!m) break;
      got.push(pick(m)); i++;
    }
    return got;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      i++;
      const code = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;                                // закрывающая ограда (её может и не быть)
      out.push('<pre>' + escapeHtml(code.join('\n')) + '</pre>');
      continue;
    }
    if (RULE.test(line)) { out.push('<hr>'); i++; continue; }
    const h = HEAD.exec(line);
    if (h) { out.push(`<b class="h h${h[1].length}">${inline(h[2])}</b>`); i++; continue; }
    if (BULLET.test(line)) {
      out.push('<ul>' + take(BULLET, m => `<li>${inline(m[1])}</li>`).join('') + '</ul>');
      continue;
    }
    if (NUMBER.test(line)) {
      const start = +NUMBER.exec(line)[1];
      const li = take(NUMBER, m => `<li>${inline(m[2])}</li>`).join('');
      out.push(`<ol${start > 1 ? ` start="${start}"` : ''}>${li}</ol>`);
      continue;
    }
    if (QUOTE.test(line)) {
      out.push('<blockquote>' + take(QUOTE, m => inline(m[1])).join('<br>') + '</blockquote>');
      continue;
    }
    // Абзац — до пустой строки или до начала другого блока.
    const para = [];
    while (i < lines.length && lines[i].trim() && !BULLET.test(lines[i]) && !NUMBER.test(lines[i])
      && !QUOTE.test(lines[i]) && !HEAD.test(lines[i]) && !RULE.test(lines[i])
      && !/^\s*```/.test(lines[i])) para.push(lines[i++]);
    out.push('<p>' + para.map(inline).join('<br>') + '</p>');
  }
  return out.join('');
}

export function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Ссылки только http(s): подставлять в href что угодно из ответа нельзя.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>');
}

export function openHighlight(h) {
  state.active = h; state.pending = h;
  if (!h.thread) h.thread = [];
  sheet.kind = 'ask';
  $('#sheetTitle').textContent = colorName(h.color);
  $('#sheetQuote').textContent = h.text;
  showNote(h);
  $('#sheetBody').innerHTML = '';
  renderThread(h);
  const box = $('#sheetChips'); box.innerHTML = '';
  COLORS.forEach(c => {
    const d = el('button', 'dot' + (c.id === h.color ? ' sel' : '')); d.style.background = c.hex;
    d.onclick = () => {
      h.color = c.id;
      eraseHighlight(h);
      drawHighlight(h); save(); openHighlight(h);
    };
    box.appendChild(d);
  });
  ACTS.forEach(a => {
    const c = el('button', 'chip', t(a.key));
    c.onclick = () => askAgent(a.kind);
    box.appendChild(c);
  });
  const wiki = el('button', 'chip strong', '<svg class="icon"><use href="#i-wiki"/></svg>' + escapeHtml(t('toWiki')));
  wiki.onclick = () => {
    sheet.kind = 'wiki'; $('#sheetTitle').textContent = TITLES.wiki;
    bubbleMe(PROMPT.saveToWiki); h.thread.push({ role: 'me', text: PROMPT.saveToWiki });
    send(wikiPrompt(h));
  };
  box.appendChild(wiki);
  const del = el('button', 'chip', '<svg class="icon"><use href="#i-trash"/></svg>' + escapeHtml(t('delete')));
  del.onclick = () => {
    eraseHighlight(h);
    // Не выкидываем, а помечаем: иначе удаление воскреснет со второго устройства.
    h.del = 1; touch(h);
    save(); closeSheet(); toast(t('highlightDeleted'));
  };
  box.appendChild(del);
  openSheet();
}
