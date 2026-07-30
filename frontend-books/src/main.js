import ePub from 'epubjs'
import './style.css'
import { paint } from './highlights.js'
import { caretAt, commitSel, sel, wordAt } from './selection.js'
import { auth, showAuth } from './auth.js'
import { $, BUILTIN, state } from './core.js'
import { allToWiki, closeDrawer, drawerHighlights, drawerPrefs, drawerSettings, drawerToc, openDrawer } from './drawers.js'
import { applyTheme, closeBook, openBook, wireGlobal } from './reader.js'
import { bubbleMe, closeSheet, contextAround, followUp, openHighlight, promptFor, send, wireScrim } from './sheet.js'
import { buildShelf, pickFile, thumbFrom } from './shelf.js'
import { lib, saveLib } from './store.js'
import { live, sync } from './sync.js'

/* ── Проводка ── */

function wireUI() {
  $('#btnBack').onclick = closeBook;
  $('#btnToc').onclick = () => openDrawer('Оглавление', drawerToc);
  $('#btnHl').onclick = () => openDrawer('Выписки', drawerHighlights,
    { icon: 'i-wiki', title: 'Собрать всё в вики', run: allToWiki });
  $('#btnSet').onclick = () => openDrawer('Вид', drawerSettings);
  $('#btnAdd').onclick = pickFile;
  $('#btnPrefs').onclick = () => openDrawer('Настройки', drawerPrefs);
  $('#drawerClose').onclick = closeDrawer;
  $('#sheetClose').onclick = closeSheet;
  wireScrim();
  $('#sheetSend').onclick = () => {
    const v = $('#sheetInput').value.trim();
    if (!v) return;
    const h = state.active;
    if (h && !(h.thread || []).length) {      // первый вопрос — с цитатой и контекстом
      h.thread = [{ role: 'me', text: v }];
      bubbleMe(v); $('#sheetInput').value = '';
      contextAround(h.cfi).then(around => send(promptFor('ask', h, around, v)));
      return;
    }
    followUp(v);
  };
  $('#sheetInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#sheetSend').click(); });
  $('#authGo').onclick = doLogin;
  $('#authPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
}

async function doLogin() {
  const pass = $('#authPass').value;
  if (!pass) return;
  $('#authErr').textContent = '';
  $('#authGo').disabled = true;
  try {
    await auth.login(pass);
    $('#auth').classList.remove('on');
    $('#authPass').value = '';
    start();
  } catch (e) {
    $('#authErr').textContent = e.message || 'Не вышло';
  } finally {
    $('#authGo').disabled = false;
  }
}

/* Книги, лежащие рядом со статикой, на полку попадают только если файл действительно есть:
   он приходит с хоста, а не из сборки. Пропавший файл убираем с полки, но лишь по честному 404 —
   офлайн запрос не удаётся вовсе, и книгу в этом случае трогать нельзя. */
async function seedLibrary() {
  const list = lib();
  for (const b of BUILTIN) {
    // Отсутствующий файл статика умеет отдавать и как index.html с кодом 200 — по типу видно.
    const st = await fetch(b.url, { method: 'HEAD' })
      .then(r => (r.ok && /html/.test(r.headers.get('content-type') || '') ? 404 : r.status))
      .catch(() => 0);
    const i = list.findIndex(x => x.id === b.id);
    if (st === 200 && i < 0) list.push({ ...b, title: '', author: '', added: Date.now() });
    if (st === 404 && i >= 0) list.splice(i, 1);
  }
  saveLib(list);
}

export async function start() {
  await seedLibrary();
  applyTheme();
  buildShelf();
  // Прогресс с других устройств подтягиваем сразу — до того, как книгу откроют.
  sync.run().then(ok => { if (ok && !state.entry) buildShelf(); }).catch(() => {});
  // Встроенную книгу разбираем один раз, чтобы полка знала её обложку и название.
  const need = lib().find(e => e.builtin && (!e.title || !e.cover));
  if (need) {
    const probe = ePub(need.url);
    probe.ready.then(async () => {
      const m = await probe.loaded.metadata;
      const entry = { ...need, title: (m.title || '').trim(), author: (m.creator || '').trim(), cover: await thumbFrom(probe) };
      saveLib(lib().map(x => x.id === entry.id ? entry : x));
      if ($('#shelf').classList.contains('on')) buildShelf();
    }).catch(() => {});
  }
}

async function boot() {
  wireGlobal();
  wireUI();
  applyTheme();
  if (await auth.check()) start();
  else showAuth('');
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* Единственная связь с внешним миром помимо DOM: набор проверок (tests/smoke.mjs) работает
   изнутри страницы и ему нужны те же функции, что и интерфейсу. */
window.__books = {
  state, sel, sync, lib, live,
  commitSel, paint, wordAt, caretAt,
  openBook, closeBook, openHighlight, closeSheet, closeDrawer, applyTheme,
};

boot();
