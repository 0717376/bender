import { auth } from './auth.js'
import { API, ls, state } from './core.js'
import { drawHighlight } from './highlights.js'
import { buildShelf } from './shelf.js'
import { lib } from './store.js'

/* ── Синхронизация ──
   Общий прогресс между устройствами. Отдельного бэкенда у читалки нет, поэтому состояние
   лежит одним файлом в вики по скрытому пути: папки с точки не попадают ни в дерево,
   ни в поиск, а PUT /files/content перезаписывает файл на месте (в отличие от загрузки
   в хранилище, которая при совпадении имени плодит копии). */

export const SYNC_PATH = '.reader/state.json';

/** Выписка живая, пока её не пометили удалённой: надгробие нужно, чтобы удаление доехало
    до второго устройства, а не воскресло оттуда при следующей склейке. */
export const live = () => state.hl.filter(h => !h.del);

export const sync = {
  last: ls.get('sync:at', 0),
  busy: null,          // промис синхронизации, пока она идёт
  timer: null,

  localOf(id) {
    return {
      at: ls.get('at:' + id, 0),
      pos: ls.get('pos:' + id, null),
      pct: ls.get('pct:' + id, 0),
      chap: ls.get('chap:' + id, ''),
      hl: ls.get('hl:' + id, []),
    };
  },

  applyTo(id, s) {
    if (!s) return;
    if (s.pos) ls.set('pos:' + id, s.pos);
    if (s.pct != null) ls.set('pct:' + id, s.pct);
    if (s.chap) ls.set('chap:' + id, s.chap);
    ls.set('hl:' + id, s.hl || []);
    ls.set('at:' + id, s.at || 0);
    if (state.entry && state.entry.id === id) {
      // Объекты не подменяем, а обновляем на месте: на открытую выписку смотрит шторка,
      // и если увести объект из-под неё, удаление или цвет уедут в ничью копию.
      const was = new Map(state.hl.map(h => [h.id, h]));
      state.hl = (s.hl || []).map(n => {
        const cur = was.get(n.id);
        if (!cur) return n;
        if (!n.del) delete cur.del;
        return Object.assign(cur, n);
      });
      if (state.rendition) live().forEach(h => {
        try { state.rendition.annotations.remove(h.cfi, 'highlight'); } catch {}
        drawHighlight(h);
      });
    }
  },

  merge(l, r) {
    l = l || {}; r = r || {};
    const newer = (l.at || 0) >= (r.at || 0) ? l : r;
    const byId = new Map();
    [...(r.hl || []), ...(l.hl || [])].forEach(h => {
      const cur = byId.get(h.id);
      if (!cur || (h.upd || h.ts || 0) >= (cur.upd || cur.ts || 0)) byId.set(h.id, h);
    });
    return {
      at: Math.max(l.at || 0, r.at || 0),
      pos: newer.pos || l.pos || r.pos || null,
      pct: newer.pct != null ? newer.pct : (l.pct != null ? l.pct : r.pct) || 0,
      chap: newer.chap || l.chap || r.chap || '',
      title: l.title || r.title || '',
      hl: [...byId.values()],
    };
  },

  async pull() {
    const r = await fetch(API + '/files/content?path=' + encodeURIComponent(SYNC_PATH),
      { headers: { Authorization: 'Bearer ' + auth.token } });
    if (r.status === 404) return { v: 1, books: {} };
    if (!r.ok) throw new Error('sync ' + r.status);
    const d = await r.json();
    let doc = {};
    try { doc = JSON.parse(d.text || '{}'); } catch {}
    if (!doc.books) doc.books = {};
    return doc;
  },

  async push(doc, keepalive) {
    await fetch(API + '/files/content', {
      method: 'PUT', keepalive: !!keepalive,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token },
      body: JSON.stringify({ path: SYNC_PATH, text: JSON.stringify(doc, null, 1) }),
    });
  },

  /** Тянем, склеиваем со своим, кладём обратно. Позиция — по времени, выписки — объединением. */
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
    try {
      const remote = await this.pull();
      const doc = { v: 1, books: Object.assign({}, remote.books) };
      lib().forEach(e => {
        const merged = this.merge(this.localOf(e.id), remote.books[e.id]);
        merged.title = e.title || merged.title;
        doc.books[e.id] = merged;
        // Позицию открытой книги не трогаем: выдёргивать человека со страницы — хамство.
        if (state.entry && state.entry.id === e.id && !o.force) {
          const keep = this.localOf(e.id);
          this.applyTo(e.id, Object.assign({}, merged, { pos: keep.pos || merged.pos }));
        } else {
          this.applyTo(e.id, merged);
        }
      });
      await this.push(doc, o.keepalive);
      this.last = Date.now(); ls.set('sync:at', this.last);
      return true;
    } catch (e) {
      console.warn('sync', e);
      return false;
    }
  },

  later(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run().then(ok => { if (ok && !state.entry) buildShelf(); }).catch(() => {}), ms || 4000);
  },
};
