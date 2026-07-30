import ePub from 'epubjs'
import { $, el, escapeHtml, ls, plural, toast } from './core.js'
import { openBook } from './reader.js'
import { fileDel, filePut, lib, saveLib } from './store.js'

/* ── Полка ── */

export function bookLabel(e) {
  const pct = ls.get('pct:' + e.id, 0);
  const n = (ls.get('hl:' + e.id, []) || []).filter(h => !h.del).length;
  const bits = [];
  if (pct > 0.005) bits.push(Math.round(pct * 100) + '%');
  if (n) bits.push(plural(n, 'выписка', 'выписки', 'выписок'));
  return bits.join(' · ');
}

export function cardFor(e) {
  const card = el('button', 'card');
  const pct = ls.get('pct:' + e.id, 0);
  card.innerHTML = `
    <div class="cover-wrap">
      ${e.cover ? `<img alt="" src="${e.cover}">` : `<div class="none">${escapeHtml(e.title || 'Книга')}</div>`}
      <div class="bar"><i style="width:${Math.round(pct * 100)}%"></i></div>
    </div>
    <div class="t">${escapeHtml(e.title || 'Без названия')}</div>
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
    ? plural(list.length, 'книга', 'книги', 'книг') + ' на полке'
    : 'полка пока пустая';

  if (reading) {
    const pct = ls.get('pct:' + reading.id, 0);
    const b = el('button', 'hero');
    b.innerHTML = `
      <div class="cv">${reading.cover ? `<img alt="" src="${reading.cover}">` : `<div class="none"></div>`}</div>
      <div class="info">
        <div class="lbl">Продолжить</div>
        <div class="t">${escapeHtml(reading.title || 'Книга')}</div>
        <div class="a">${escapeHtml(reading.author || '')}</div>
        <div class="line"><i style="width:${Math.round(pct * 100)}%"></i></div>
        <div class="m">${Math.round(pct * 100)}% · ${escapeHtml(ls.get('chap:' + reading.id, '') || 'читаешь')}</div>
      </div>`;
    b.onclick = () => openBook(reading);
    heroSlot.appendChild(b);
  }

  if (reading) wrap.appendChild(el('div', 'sec', 'Вся полка'));
  const grid = el('div', 'grid');
  list.sort((a, b) => (b.opened || b.added || 0) - (a.opened || a.added || 0)).forEach(e => grid.appendChild(cardFor(e)));

  const add = el('button', 'card');
  add.innerHTML = `<div class="add"><svg class="icon"><use href="#i-plus"/></svg>Добавить</div>`;
  add.onclick = pickFile;
  grid.appendChild(add);
  wrap.appendChild(grid);

  $('#shelf').classList.add('on');
  $('#splash').classList.add('off');
}

export function bookMenu(e, anchor) {
  const m = $('#menu');
  m.innerHTML = '';
  const open = el('button', '', '<svg class="icon"><use href="#i-book"/></svg>Открыть');
  open.onclick = () => { hideMenu(); openBook(e); };
  m.appendChild(open);
  const del = el('button', 'danger', '<svg class="icon"><use href="#i-trash"/></svg>Удалить с полки');
  del.onclick = async () => {
    hideMenu();
    if (!confirm(`Удалить «${e.title || 'книгу'}»? Выписки тоже пропадут.`)) return;
    if (!e.builtin) await fileDel(e.id);
    ['pct:', 'pos:', 'hl:', 'loc:', 'chap:'].forEach(p => ls.del(p + e.id));
    saveLib(lib().filter(x => x.id !== e.id));
    buildShelf(); toast('Удалено');
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
  const inp = el('input'); inp.type = 'file'; inp.accept = '.epub,application/epub+zip';
  inp.onchange = async () => { if (inp.files[0]) await importBook(inp.files[0]); };
  inp.click();
}

export async function importBook(file) {
  $('#splash').classList.remove('off');
  $('#splash').textContent = 'разбираю книгу…';
  try {
    const buf = await file.arrayBuffer();
    const probe = ePub(buf);
    await probe.ready;
    const meta = await probe.loaded.metadata;
    // Идентификатор — от содержимого файла: тот же epub на телефоне и на компьютере
    // должен получить тот же id, иначе прогресс не сойдётся.
    const id = await hashId(buf);
    if (lib().find(x => x.id === id)) {
      $('#splash').classList.add('off');
      toast('Эта книга уже на полке');
      return;
    }
    const entry = {
      id, title: (meta.title || file.name.replace(/\.epub$/i, '')).trim(),
      author: (meta.creator || '').trim(), added: Date.now(),
      cover: await thumbFrom(probe),
    };
    await filePut(id, buf);
    saveLib([...lib(), entry]);
    buildShelf();
    openBook(entry);
  } catch (e) {
    console.warn(e);
    $('#splash').classList.add('off');
    toast('Не смог открыть этот файл');
  }
}

export async function hashId(buf) {
  try {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return 'b' + Date.now().toString(36); }   // http без TLS — crypto.subtle недоступен
}

/** Обложку кладём в индекс уменьшенной: полка должна рисоваться без чтения самих книг. */
export async function thumbFrom(book) {
  try {
    const url = await book.coverUrl();
    if (!url) return '';
    const img = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    const w = 300, h = Math.round(img.height * (w / img.width));
    const c = el('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.78);
  } catch { return ''; }
}
