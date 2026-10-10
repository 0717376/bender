import type { Card, Deck, Fields, Kind, Note, Overview, Session, Settings, Stats } from "./types";

const TOKEN_KEY = "cards_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/** Сессия протухла или пароль сменили: приложение слушает это и показывает вход. */
export const UNAUTHORIZED = "cards:unauthorized";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED));
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? res.statusText);
  return res.json();
}

export async function login(password: string): Promise<void> {
  const { token } = await req<{ token: string }>("POST", "/auth/login", { password });
  setToken(token);
}

/** Голосовой ввод в чате — общий сервис распознавания, тот же, что у вики и задач. */
export async function transcribeAudio(blob: Blob): Promise<string | null> {
  const fd = new FormData();
  fd.append("audio", blob, "recording.webm");
  fd.append("model_id", "gigaam-rnnt");
  const res = await fetch("/api/asr/transcribe", {
    method: "POST",
    headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {},
    body: fd,
  });
  if (!res.ok) throw new Error("ASR error");
  return (await res.json()).text || null;
}

const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "" && v !== false) p.set(k, String(v)); });
  const s = p.toString();
  return s ? "?" + s : "";
};

export interface NoteBody { kind?: Kind; fields?: Fields; deck?: number | string | null; tags?: string[] }

export const api = {
  overview: () => req<Overview>("GET", "/cards/overview"),
  stats: () => req<Stats>("GET", "/cards/stats"),
  settings: () => req<Settings>("GET", "/cards/settings"),
  saveSettings: (patch: Partial<Settings>) => req<Settings>("PUT", "/cards/settings", patch),

  next: (deck?: number) => req<Session>("GET", "/cards/next" + qs({ deck })),
  answer: (id: number, rating: number, duration: number, deck?: number) =>
    req<Session & { result: { leech: boolean } }>("POST", `/cards/${id}/answer`, { rating, duration, deck }),
  undo: (deck?: number) => req<Session>("POST", "/cards/undo" + qs({ deck })),
  suspend: (id: number, suspended: boolean) => req<{ ok: boolean }>("POST", `/cards/${id}/suspend`, { suspended }),

  createDeck: (name: string) => req<Deck>("POST", "/cards/decks", { name }),
  updateDeck: (id: number, body: Partial<Pick<Deck, "name" | "descr" | "new_per_day" | "retention">>) =>
    req<Deck>("PATCH", `/cards/decks/${id}`, body),
  removeDeck: (id: number) => req<{ ok: boolean }>("DELETE", `/cards/decks/${id}`),

  notes: (f: { q?: string; deck?: number; status?: string; leech?: boolean }) =>
    req<Note[]>("GET", "/cards/notes" + qs({ ...f, limit: 300 })),
  note: (id: number) => req<Note>("GET", `/cards/notes/${id}`),
  createNote: (body: NoteBody) => req<Note>("POST", "/cards/notes", body),
  updateNote: (id: number, body: NoteBody) => req<Note>("PATCH", `/cards/notes/${id}`, body),
  removeNote: (id: number) => req<{ ok: boolean }>("DELETE", `/cards/notes/${id}`),
  retryNote: (id: number) => req<Note>("POST", `/cards/notes/${id}/retry`),
  quick: (text: string, ui: string) => req<Note>("POST", "/cards/quick", { text, ui }),
};

export type { Card };

/** Правки со стороны — бот, агент, другое устройство. Возвращает функцию отписки. */
export function subscribeCards(onChange: () => void): () => void {
  const es = new EventSource(`/cards/events?token=${getToken()}`);
  es.addEventListener("cards", onChange);
  return () => es.close();
}
