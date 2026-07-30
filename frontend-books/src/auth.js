import { $, API, ls } from './core.js'

/* ── Авторизация ── */

export const auth = {
  get token() { return ls.get('token', ''); },
  set token(v) { v ? ls.set('token', v) : ls.del('token'); },
  async login(pass) {
    const r = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass }),
    });
    if (!r.ok) throw new Error(r.status === 401 ? 'Неверный пароль' : 'Сервер ответил ' + r.status);
    const d = await r.json();
    this.token = d.token;
    return d.token;
  },
  /** Проверять токен имеет смысл только онлайн: офлайн читалка обязана открываться. */
  async check() {
    if (!this.token) return false;
    if (!navigator.onLine) return true;
    try {
      const r = await fetch(API + '/auth/me', { headers: { Authorization: 'Bearer ' + this.token } });
      if (r.status === 401) { this.token = ''; return false; }
      return true;
    } catch { return true; }
  },
  forget() { this.token = ''; },
};

export function showAuth(err) {
  $('#auth').classList.add('on');
  $('#authErr').textContent = err || '';
  $('#splash').classList.add('off');
  setTimeout(() => $('#authPass').focus(), 100);
}
