import type { Overview, Task } from "./types";

const TOKEN_KEY = "wiki_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearToken();
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? res.statusText);
  return res.json();
}

export async function login(password: string): Promise<string> {
  const { token } = await req<{ token: string }>("POST", "/auth/login", { password });
  setToken(token);
  return token;
}

/** Speech-to-text via the shared backend ASR endpoint (same as the wiki uses). */
export async function transcribeAudio(blob: Blob): Promise<string | null> {
  const fd = new FormData();
  fd.append("audio", blob, "recording.webm");
  fd.append("model_id", "gigaam-rnnt");
  const res = await fetch("/api/asr/transcribe", {
    method: "POST",
    headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {},
    body: fd, // no content-type — the browser sets the multipart boundary
  });
  if (!res.ok) throw new Error("ASR error");
  const r = await res.json();
  return r.text || null;
}

export const api = {
  overview: () => req<Overview>("GET", "/tasks/overview"),
  list: (view: string, projectId?: number, tag?: string, areaId?: number) =>
    req<{ tasks: Task[] }>(
      "GET",
      `/tasks?` + new URLSearchParams({
        ...(view && { view }),
        ...(projectId && { project_id: String(projectId) }),
        ...(tag && { tag }),
        ...(areaId && { area_id: String(areaId) }),
      }),
    ).then((r) => r.tasks),
  get: (id: number) => req<Task>("GET", `/tasks/${id}`),
  search: (q: string) =>
    req<{ tasks: Task[] }>("GET", `/tasks/search?` + new URLSearchParams({ q })).then((r) => r.tasks),
  create: (body: Partial<Task> & { title: string; when?: string; project?: number | string }) =>
    req<Task>("POST", "/tasks", body),
  patch: (id: number, body: Record<string, unknown>) => req<Task>("PATCH", `/tasks/${id}`, body),
  complete: (id: number, done: boolean) => req<Task>("POST", `/tasks/${id}/complete`, { done }),
  remove: (id: number) => req<{ ok: boolean }>("DELETE", `/tasks/${id}`),
  restore: (id: number) => req<Task>("POST", `/tasks/${id}/restore`),
  updateProject: (id: number, body: Record<string, unknown>) =>
    req<Record<string, unknown>>("PATCH", `/tasks/projects/${id}`, body),
  reorder: (ids: number[]) => req<{ ok: boolean }>("POST", "/tasks/reorder", { ids }),
  createProject: (title: string, area_id?: number | null) =>
    req<{ id: number }>("POST", "/tasks/projects", { title, area_id }),
  createArea: (title: string) => req<{ id: number }>("POST", "/tasks/areas", { title }),
  updateArea: (id: number, title: string) =>
    req<Record<string, unknown>>("PATCH", `/tasks/areas/${id}`, { title }),
  removeArea: (id: number) => req<{ ok: boolean }>("DELETE", `/tasks/areas/${id}`),
  // Checklist
  checkAdd: (taskId: number, title: string) =>
    req<{ id: number }>("POST", `/tasks/${taskId}/checklist`, { title }),
  checkToggle: (itemId: number, done: boolean) =>
    req<{ ok: boolean }>("POST", `/tasks/checklist/${itemId}/toggle`, { done }),
  checkRemove: (itemId: number) => req<{ ok: boolean }>("DELETE", `/tasks/checklist/${itemId}`),
};

/** Subscribe to server-side task changes (chat / Telegram / cron). Returns an unsubscribe fn. */
export function subscribeTasks(onChange: () => void): () => void {
  const es = new EventSource(`/tasks/events?token=${getToken()}`);
  es.addEventListener("tasks", onChange);
  return () => es.close();
}
