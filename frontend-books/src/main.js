import './style.css'
import { paint } from './highlights.js'
import { caretAt, commitSel, sel, wordAt } from './selection.js'
import { auth, showAuth } from './auth.js'
import { $, state } from './core.js'
import { allToWiki, closeDrawer, drawerFind, drawerHighlights, drawerPrefs, drawerSettings, drawerToc, openDrawer } from './drawers.js'
import { applyTheme, closeBook, openBook, wireGlobal, wireScrub } from './reader.js'
import { bubbleMe, closeSheet, contextAround, followUp, openHighlight, promptFor, send, wireScrim, wireSheetKeyboard } from './sheet.js'
import { buildShelf, pickFile, refreshShelf, wireShelfDrop } from './shelf.js'
import { lib } from './store.js'
import { live, sync } from './sync.js'
import { closeStats, openStats, wireReadingBeat } from './stats.js'

/* ── Проводка ── */

function wireUI() {
  $('#btnBack').onclick = closeBook;
  $('#btnFind').onclick = () => openDrawer('Поиск', drawerFind);
  $('#btnToc').onclick = () => openDrawer('Оглавление', drawerToc);
  $('#btnHl').onclick = () => openDrawer('Выписки', drawerHighlights,
    { icon: 'i-wiki', title: 'Собрать всё в вики', run: allToWiki });
  $('#btnSet').onclick = () => openDrawer('Вид', drawerSettings);
  $('#btnAdd').onclick = pickFile;
  wireShelfDrop();
  $('#btnStats').onclick = openStats;
  $('#statsClose').onclick = closeStats;
  $('#btnPrefs').onclick = () => openDrawer('Настройки', drawerPrefs);
  $('#drawerClose').onclick = closeDrawer;
  $('#sheetClose').onclick = closeSheet;
  wireScrim();
  wireSheetKeyboard();
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

export async function start() {
  applyTheme();
  buildShelf();                 // сразу то, что помним с прошлого раза
  await refreshShelf();         // и то, что на сервере
  // Что не доехало в прошлый раз — уходит сейчас, а прогресс приезжает вместе с полкой.
  sync.run().then(ok => { if (ok) refreshShelf(); }).catch(() => {});
  // Правку с другого устройства ждём событием, а не следующим открытием приложения.
  sync.onRemote = () => { clearTimeout(shelfTimer); shelfTimer = setTimeout(refreshShelf, 800); };
  sync.listen();
}

let shelfTimer = null;

async function boot() {
  wireGlobal();
  wireUI();
  wireScrub();
  wireReadingBeat();
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
  state, sel, sync, lib, live, refreshShelf,
  commitSel, paint, wordAt, caretAt,
  openBook, closeBook, openHighlight, closeSheet, closeDrawer, applyTheme,
  openStats, closeStats,
};

boot();
