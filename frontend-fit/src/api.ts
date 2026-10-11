import type {
  BodyRow, Exercise, Kind, OuraStatus, Overview, PlanDay, Program, Progress, Recovery, Session, Settings, Week,
} from "./types";

const TOKEN_KEY = "fit_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/** Сессия протухла или пароль сменили: приложение слушает это и показывает вход. */
export const UNAUTHORIZED = "fit:unauthorized";

/** Сервер ответил отказом — в отличие от обрыва связи, повторять такой запрос бессмысленно. */
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
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
    throw new HttpError(401, "unauthorized");
  }
  if (!res.ok) throw new HttpError(res.status, (await res.json().catch(() => ({}))).detail ?? res.statusText);
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

export interface LogBody {
  kind: Kind;
  day?: string;
  minutes?: number;
  distance_km?: number;
  feel?: number;
  note?: string;
  title?: string;
  program_day?: string;
}

export const api = {
  overview: () => req<Overview>("GET", "/fit/overview"),
  settings: () => req<Settings>("GET", "/fit/settings"),
  saveSettings: (patch: Partial<Settings>) => req<Settings>("PUT", "/fit/settings", patch),

  sessions: (limit = 60) => req<Session[]>("GET", `/fit/sessions?limit=${limit}`),
  session: (id: number) => req<Session>("GET", `/fit/sessions/${id}`),
  log: (body: LogBody) => req<Session>("POST", "/fit/sessions/log", body),
  updateSession: (id: number, body: Partial<Pick<Session, "note" | "feel" | "program_day_id">>) =>
    req<Session>("PATCH", `/fit/sessions/${id}`, body),
  removeSession: (id: number) => req<{ ok: boolean }>("DELETE", `/fit/sessions/${id}`),

  program: () => req<Program | null>("GET", "/fit/program"),
  plan: (dayId: number, easy: boolean) => req<PlanDay>("GET", `/fit/program/days/${dayId}?easy=${easy}`),
  exercises: () => req<Exercise[]>("GET", "/fit/exercises"),
  usedExercises: () => req<Exercise[]>("GET", "/fit/exercises?used=true"),
  progress: (exerciseId: number) => req<Progress>("GET", `/fit/exercises/${exerciseId}/progress`),
  weeks: (n = 12) => req<Week[]>("GET", `/fit/weeks?n=${n}`),

  body: () => req<BodyRow[]>("GET", "/fit/body"),
  logBody: (weight: number) => req<BodyRow>("POST", "/fit/body", { weight }),

  recovery: (days = 30) => req<Recovery>("GET", `/fit/recovery?days=${days}`),
  oura: () => req<OuraStatus>("GET", "/fit/oura"),
  ouraConnect: () => req<{ url: string }>("POST", "/fit/oura/connect", { origin: location.origin }),
  ouraSync: () => req<OuraStatus>("POST", "/fit/oura/sync"),
  ouraDisconnect: () => req<OuraStatus>("DELETE", "/fit/oura"),
};

/** Правки со стороны — агент, синхронизация кольца, другое устройство. Возвращает отписку. */
export function subscribeFit(onChange: () => void): () => void {
  const es = new EventSource(`/fit/events?token=${getToken()}`);
  es.addEventListener("fit", onChange);
  return () => es.close();
}
