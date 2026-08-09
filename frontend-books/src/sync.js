import { auth } from './auth.js'
import { API, ls, state } from './core.js'
import { drawHighlight } from './highlights.js'

/* ── Прогресс и выписки ──
   Состояние живёт на сервере (books.db), клиент держит копию в localStorage: полка и
   страница рисуются сразу, а обмен идёт следом. Порядок операций один — серверный,
   поэтому склейка сводится к «кто позже тронул, тот и прав» по времени правки.
   Что не доехало (самолёт, метро), помечено и уходит следующей попыткой. */

/** Выписка живая, пока её не пометили удалённой: надгробие нужно, чтобы удаление доехало
    до второго устройства, а не воскресло оттуда при следующей склейке. */
export const live = () => state.hl.filter(h => !h.del);

const head = () => ({ Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' });

/* У устройства своё имя: сервер возвращает его в событии, и своё же эхо забирать не надо. */
export const CLIENT = (() => {
  let id = ls.get('client', '');
  if (!id) { id = Math.random().toString(36).slice(2, 10); ls.set('client', id); }
  return id;
})();

/* На клиенте выписки исторически с полями ts/upd/del, на сервере — created/updated/deleted. */
const toServer = h => ({
  id: h.id, cfi: h.cfi, text: h.text, color: h.color, chapter: h.chapter, note: h.note || '',
  thread: h.thread || [], created: h.ts || 0, updated: h.upd || h.ts || 0, deleted: !!h.del,
});
const fromServer = h => {
  const out = { id: h.id, cfi: h.cfi, text: h.text, color: h.color, chapter: h.chapter,
                note: h.note || '', thread: h.thread || [], ts: h.created, upd: h.updated };
  if (h.deleted) out.del = 1;
  return out;
};

const DIRTY = 'dirty';
const dirty = () => ls.get(DIRTY, []);
/** Пометить книгу: здесь есть неотправленное. */
export function markDirty(id) {
  const d = dirty();
  if (!d.includes(id)) { d.push(id); ls.set(DIRTY, d); }
}
const clean = id => ls.set(DIRTY, dirty().filter(x => x !== id));

/** Разложить пришедшие выписки, не подменяя объекты открытой книги: на них смотрит
    шторка, и увод объекта из-под неё теряет правку. */
function applyHighlights(id, list) {
  const mapped = list.map(fromServer);
  ls.set('hl:' + id, mapped);
  if (!state.entry || state.entry.id !== id) return;
  const was = new Map(state.hl.map(h => [h.id, h]));
  state.hl = mapped.map(n => {
    const cur = was.get(n.id);
    if (!cur) return n;
    if (!n.del) delete cur.del;
    return Object.assign(cur, n);
  });
  if (state.kind === 'pdf') { if (state.pdf) state.pdf.redraw(); return; }
  if (state.rendition) live().forEach(h => {
    try { state.rendition.annotations.remove(h.cfi, 'highlight'); } catch {}
    drawHighlight(h);
  });
}

export function applyPosition(id, pos) {
  if (!pos || !pos.cfi) return;
  if ((pos.updated || 0) <= ls.get('at:' + id, 0)) return;
  ls.set('pct:' + id, pos.pct || 0);
  ls.set('chap:' + id, pos.chapter || '');
  ls.set('at:' + id, pos.updated || 0);
  // Позицию открытой книги не трогаем: выдёргивать человека со страницы — хамство.
  if (!state.entry || state.entry.id !== id) ls.set('pos:' + id, pos.cfi);
}

export const sync = {
  last: ls.get('sync:at', 0),
  busy: null,          // промис синхронизации, пока она идёт
  timer: null,

  /** Забрать состояние книги — перед открытием, чтобы встать там, где бросил. */
  async pull(id) {
    if (!auth.token || !navigator.onLine) return false;
    const r = await fetch(`${API}/books/${id}/state`, { headers: head() });
    if (!r.ok) throw new Error('состояние: ' + r.status);
    const d = await r.json();
    applyHighlights(id, d.highlights || []);
    applyPosition(id, d.position);
    return true;
  },

  /** Отдать своё и получить обратно склеенное: сервер оставляет более позднюю версию. */
  async push(id, keepalive) {
    const r = await fetch(`${API}/books/${id}/highlights?client=${CLIENT}`, {
      method: 'PUT', headers: head(), keepalive: !!keepalive,
      body: JSON.stringify(ls.get('hl:' + id, []).map(toServer)),
    });
    if (!r.ok) throw new Error('выписки: ' + r.status);
    applyHighlights(id, await r.json());

    const cfi = ls.get('pos:' + id, null);
    if (cfi) {
      const p = await fetch(`${API}/books/${id}/position?client=${CLIENT}`, {
        method: 'PUT', headers: head(), keepalive: !!keepalive,
        body: JSON.stringify({ cfi, pct: ls.get('pct:' + id, 0), chapter: ls.get('chap:' + id, ''),
                               updated: ls.get('at:' + id, 0) || undefined }),
      });
      if (!p.ok) throw new Error('позиция: ' + p.status);
      applyPosition(id, await p.json());
    }
    clean(id);
    return true;
  },

  /* Занятую синхронизацию не пропускаем, а ждём: иначе открытие книги сразу после запуска
     возвращалось бы без позиции с другого устройства — синхронизация старта ещё в полёте. */
  async run(opts) {
    const o = opts || {};
    if (!auth.token || !navigator.onLine) return false;
    if (this.busy) {
      if (!o.force) return this.busy;
      try { await this.busy; } catch {}
    }
    this.busy = this._run(o);
    try { return await this.busy; } finally { this.busy = null; }
  },

  async _run(o) {
    const open = state.entry ? state.entry.id : null;
    const ids = [...new Set([...dirty(), ...(open ? [open] : [])])];
    try {
      for (const id of ids) await this.push(id, o.keepalive);
      this.last = Date.now(); ls.set('sync:at', this.last);
      return true;
    } catch (e) {
      console.warn('sync', e);
      return false;
    }
  },

  later(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run().catch(() => {}), ms || 4000);
  },

  /* ── Живая синхронизация ──
     Сервер шлёт тик на каждое изменение — что именно менялось, забираем сами. Так
     выписка, сделанная на телефоне, появляется в открытой на ноутбуке книге, а не
     через полчаса «когда-нибудь синхронизируется». */
  es: null,
  onRemote: null,        // ставит main.js: обновить полку

  listen() {
    if (this.es || !auth.token || typeof EventSource === 'undefined') return;
    const es = new EventSource(`${API}/books/events?token=${encodeURIComponent(auth.token)}`);
    es.addEventListener('books', e => {
      let d;
      try { d = JSON.parse(e.data); } catch { return; }
      if (d.src === CLIENT) return;                     // это мы сами и наделали
      const open = state.entry && state.entry.id;
      if (d.book && d.book === open) this.pull(d.book).catch(() => {});
      else if (this.onRemote) this.onRemote(d);
    });
    // Обрыв EventSource чинит сам; закрытый наглухо (пароль сменили) — не наше дело.
    this.es = es;
  },

  stop() {
    if (this.es) { this.es.close(); this.es = null; }
  },
};
