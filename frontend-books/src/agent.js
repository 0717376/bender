import { auth, showAuth } from './auth.js'
import { API } from './core.js'

/* ── Агент ── */

export const agent = {
  ws: null, pending: null, onEvent: null, busy: false,
  connect() {
    if (this.ws && this.ws.readyState === 1) return Promise.resolve(this.ws);
    if (this.pending) return this.pending;
    this.pending = new Promise((res, rej) => {
      let ws;
      try {
        const base = API ? API.replace(/^http/, 'ws')
          : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
        ws = new WebSocket(base + '/chat/ws?token=' + encodeURIComponent(auth.token) + '&surface=wiki');
      } catch (e) { this.pending = null; return rej(e); }
      const t = setTimeout(() => { try { ws.close(); } catch {} ; this.pending = null; rej(new Error('Агент не отвечает')); }, 15000);
      ws.onopen = () => { clearTimeout(t); this.ws = ws; this.pending = null; res(ws); };
      ws.onerror = () => { clearTimeout(t); this.pending = null; rej(new Error('Нет связи с агентом')); };
      ws.onclose = e => {
        this.ws = null;
        if (e.code === 4001) { auth.forget(); showAuth('Сессия истекла, войди заново'); }
        else if (this.busy) { this.fire({ t: 'error', text: 'Связь оборвалась' }); this.fire({ t: 'done' }); }
      };
      ws.onmessage = m => { try { this.fire(JSON.parse(m.data)); } catch {} };
    });
    return this.pending;
  },
  fire(ev) { if (this.onEvent) this.onEvent(ev); },
  async send(text, context) {
    const ws = await this.connect();
    ws.send(JSON.stringify({ type: 'message', text, context: context || {} }));
  },
};
