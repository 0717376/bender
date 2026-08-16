import { $, el, escapeHtml, ls, toast } from './core.js'
import { plural, ru, t } from './i18n.js'
import { coverUrl, deleteBook, ensureThumbs, listBooks, mergeShelf, uploadBook } from './library.js'
import { openBook } from './reader.js'
import { fileDel, filePut, lib, saveLib } from './store.js'

/* ── Полка ── */

export function bookLabel(e) {
  const pct = ls.get('pct:' + e.id, 0);
  // Книгу могли читать на другом устройстве — тогда счёт выписок знает только сервер.
  const mine = ls.get('hl:' + e.id, null);
  const n = mine ? mine.filter(h => !h.del).length : (e.highlights || 0);
  const bits = [];
  if (pct > 0.005) bits.push(Math.round(pct * 100) + '%');
  if (n) bits.push(plural(n, 'highlights'));
  return bits.join(' · ');
}

export function cardFor(e) {
  const card = el('button', 'card');
  const pct = ls.get('pct:' + e.id, 0);
  card.innerHTML = `
    <div class="cover-wrap">
      ${e.cover || e.thumb ? `<img alt="" src="${coverUrl(e)}">` : `<div class="none">${escapeHtml(e.title || t('book'))}</div>`}
      <div class="bar"><i style="width:${Math.round(pct * 100)}%"></i></div>
    </div>
    <div class="t">${escapeHtml(e.title || t('untitled'))}</div>
    <div class="a">${escapeHtml([e.author, bookLabel(e)].filter(Boolean).join(' · '))}</div>
    <button class="more"><svg class="icon" style="width:16px;height:16px"><use href="#i-more"/></svg></button>`;
  card.onclick = ev => {
    if (ev.target.closest('.more')) { ev.stopPropagation(); return bookMenu(e, ev.target.closest('.more')); }
    openBook(e);
  };
  return card;
}

export function buildShelf() {
  const list = lib();
  const heroSlot = $('#heroSlot'), wrap = $('#gridWrap');
  heroSlot.innerHTML = ''; wrap.innerHTML = '';

  const reading = list.filter(e => { const p = ls.get('pct:' + e.id, 0); return p > 0.005 && p < 0.995; })
    .sort((a, b) => (b.opened || 0) - (a.opened || 0))[0];

  $('#shelfSub').textContent = list.length
    ? t('onShelf', plural(list.length, 'books'))
    : t('shelfEmpty');

  if (reading) {
    const pct = ls.get('pct:' + reading.id, 0);
    const b = el('button', 'hero');
    b.innerHTML = `
      <div class="cv">${reading.cover || reading.thumb ? `<img alt="" src="${coverUrl(reading)}">` : `<div class="none"></div>`}</div>
      <div class="info">
        <div class="lbl">${escapeHtml(t('continueReading'))}</div>
        <div class="t">${escapeHtml(reading.title || t('book'))}</div>
        <div class="a">${escapeHtml(reading.author || '')}</div>
        <div class="line"><i style="width:${Math.round(pct * 100)}%"></i></div>
        <div class="m">${Math.round(pct * 100)}% · ${escapeHtml(ls.get('chap:' + reading.id, '') || t('reading'))}</div>
      </div>`;
    b.onclick = () => openBook(reading);
    heroSlot.appendChild(b);
  }

  if (reading) wrap.appendChild(el('div', 'sec', escapeHtml(t('wholeShelf'))));
  const grid = el('div', 'grid');
  list.sort((a, b) => (b.opened || b.added || 0) - (a.opened || a.added || 0)).forEach(e => grid.appendChild(cardFor(e)));

  const add = el('button', 'card');
  add.innerHTML = `<div class="add"><svg class="icon"><use href="#i-plus"/></svg>${escapeHtml(t('add'))}</div>`;
  add.onclick = pickFile;
  grid.appendChild(add);
  wrap.appendChild(grid);

  $('#shelf').classList.add('on');
  $('#splash').classList.add('off');
}

export function bookMenu(e, anchor) {
  const m = $('#menu');
  m.innerHTML = '';
  const open = el('button', '', '<svg class="icon"><use href="#i-book"/></svg>' + escapeHtml(t('open')));
  open.onclick = () => { hideMenu(); openBook(e); };
  m.appendChild(open);
  const del = el('button', 'danger', '<svg class="icon"><use href="#i-trash"/></svg>' + escapeHtml(t('removeFromShelf')));
  del.onclick = async () => {
    hideMenu();
    if (!confirm(t('deleteBookQ', e.title || t('book').toLowerCase()))) return;
    try { await deleteBook(e.id); } catch { return toast(t('deleteFailed')); }
    await fileDel(e.id);
    ['pct:', 'pos:', 'hl:', 'loc:', 'chap:', 'at:'].forEach(p => ls.del(p + e.id));
    saveLib(lib().filter(x => x.id !== e.id));
    buildShelf(); toast(t('deleted'));
  };
  m.appendChild(del);
  const r = anchor.getBoundingClientRect();
  m.classList.add('on');
  const w = m.offsetWidth;
  m.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
  m.style.top = (r.bottom + 6) + 'px';
}
export function hideMenu() { $('#menu').classList.remove('on'); }

export function pickFile() {
  // Поле живёт в документе, а не в локальной переменной: отвязанный input Safari успевает
  // убрать сборщиком мусора, пока открыт диалог выбора, — и onchange не приходит никогда.
  let inp = $('#filePick');
  if (!inp) {
    inp = el('input'); inp.type = 'file'; inp.accept = '.epub,.pdf,application/epub+zip,application/pdf';
    inp.id = 'filePick'; inp.hidden = true;
    inp.onchange = async () => {
      const f = inp.files[0];
      inp.value = '';               // ту же книгу можно выбрать ещё раз
      if (f) await importBook(f);
    };
    document.body.appendChild(inp);
  }
  inp.click();
}

/** Уронить книгу на полку — тоже импорт: на большом экране это привычнее кнопки. */
export function wireShelfDrop() {
  document.addEventListener('dragover', e => {
    if ($('#shelf').classList.contains('on')) e.preventDefault();
  });
  document.addEventListener('drop', e => {
    if (!$('#shelf').classList.contains('on')) return;
    e.preventDefault();             // иначе браузер уходит со страницы открывать файл
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    const f = files.find(x => /\.(epub|pdf)$/i.test(x.name || ''));
    if (f) importBook(f);
    else if (files.length) toast(t('notEpubOrPdf'));
  });
}

export async function importBook(file) {
  $('#splash').classList.remove('off');
  $('#splash').textContent = t('parsingBook');
  try {
    // Разбирает сервер: он же вычищает из книги исполняемое и заводит текст глав для агента.
    const meta = await uploadBook(file);
    if (meta.known) toast(t('alreadyOnShelf'));
    mergeShelf(await listBooks());
    filePut(meta.id, await file.arrayBuffer()).catch(() => {});
    buildShelf();
    openBook(lib().find(e => e.id === meta.id) || meta);
    // Миниатюру делаем следом, не задерживая открытие книги.
    ensureThumbs(lib()).then(n => n && buildShelf()).catch(() => {});
  } catch (e) {
    console.warn(e);
    $('#splash').classList.add('off');
    // Разбор — на сервере, и жалуется он по-русски: английскому интерфейсу такое не показываем.
    toast(ru && /не epub/i.test(e.message || '') ? e.message : t('cantAddBook'));
  }
}

/** Полка с сервера: одна и та же на всех устройствах. */
export async function refreshShelf() {
  try {
    const list = mergeShelf(await listBooks());
    buildShelf();
    if (await ensureThumbs(list)) buildShelf();
    return true;
  } catch {
    return false;      // офлайн — рисуем то, что помним
  }
}
