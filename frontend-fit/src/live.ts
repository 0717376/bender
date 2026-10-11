/* Идущая тренировка живёт в телефоне, а не на сервере: в зале связь пропадает на полчаса,
   и подход, который не записался, — худшее, что может сделать дневник. Каждое действие сразу
   видно на экране и ложится в очередь; очередь уходит на сервер, когда может. У тренировки
   и у подхода своя метка (uid): повторная отправка после обрыва не создаёт дублей. */

import { HttpError, req } from "./api";
import type { Hint, Kind, PlanDay, Session } from "./types";

export interface WItem {
  exercise_id: number;
  name: string;
  name_en: string;
  kind: "strength" | "time";
  step: number;
  sets: number;
  reps_min: number;
  reps_max: number;
  rir: number;
  rest: number;
  weight: number | null;
  reps: number;
  hint?: Hint;
  last?: { weight: number; reps: number }[];
  last_day?: string | null;
}

export interface DoneSet {
  uid: string;
  exercise_id: number;
  weight: number;
  reps: number;
  warm: boolean;
  at: number;
}

export interface Workout {
  uid: string;
  dayId: number | null;
  dayName: string;
  kind: Kind;
  easy: boolean;
  startedAt: number;
  items: WItem[];
  done: DoneSet[];
  /** До какого момента идёт отдых и сколько он длится — чтобы таймер пережил перезагрузку. */
  restUntil: number | null;
  restTotal: number;
}

type Op =
  | { t: "start"; uid: string; body: Record<string, unknown> }
  | { t: "set"; sess: string; uid: string; body: Record<string, unknown> }
  | { t: "edit"; uid: string; body: Record<string, unknown> }
  | { t: "del"; uid: string }
  | { t: "finish"; sess: string; body: Record<string, unknown> }
  | { t: "drop"; sess: string };

const WORKOUT = "fit_workout";
const OUTBOX = "fit_outbox";
const IDS = "fit_ids";

const load = <T,>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; }
};
const save = (key: string, v: unknown) => localStorage.setItem(key, JSON.stringify(v));

export const newUid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

// ── Тренировка ──

export const current = (): Workout | null => load<Workout | null>(WORKOUT, null);

export function keep(w: Workout | null): void {
  if (w) save(WORKOUT, w);
  else localStorage.removeItem(WORKOUT);
}

export function begin(plan: PlanDay | null, now = Date.now()): Workout {
  const w: Workout = {
    uid: newUid(),
    dayId: plan?.id ?? null,
    dayName: plan?.name ?? "",
    kind: plan?.kind ?? "strength",
    easy: !!plan?.easy,
    startedAt: now,
    items: (plan?.items ?? []).map((i) => ({
      exercise_id: i.exercise_id, name: i.name, name_en: i.name_en, kind: i.kind, step: i.step,
      sets: i.sets, reps_min: i.reps_min, reps_max: i.reps_max, rir: i.rir, rest: i.rest,
      weight: i.weight ?? null, reps: i.reps ?? i.reps_min, hint: i.hint, last: i.last, last_day: i.last_day,
    })),
    done: [],
    restUntil: null,
    restTotal: 0,
  };
  push({ t: "start", uid: w.uid, body: { kind: w.kind, program_day_id: w.dayId, uid: w.uid, at: now } });
  keep(w);
  return w;
}

/** Тренировку начали на другом устройстве или приложение переустановили: собрать её с сервера. */
export function adopt(s: Session, plan: PlanDay | null): Workout {
  const uid = "srv" + s.id;
  rememberId(uid, s.id);
  const done = s.sets.map((x) => {
    const u = x.uid ?? "srv" + x.id;
    rememberId(u, x.id);
    return { uid: u, exercise_id: x.exercise_id, weight: x.weight, reps: x.reps, warm: x.warm, at: s.started };
  });
  const base = plan && plan.id === s.program_day_id ? plan : null;
  const items: WItem[] = (base?.items ?? []).map((i) => ({
    exercise_id: i.exercise_id, name: i.name, name_en: i.name_en, kind: i.kind, step: i.step,
    sets: i.sets, reps_min: i.reps_min, reps_max: i.reps_max, rir: i.rir, rest: i.rest,
    weight: i.weight ?? null, reps: i.reps ?? i.reps_min, hint: i.hint, last: i.last, last_day: i.last_day,
  }));
  for (const x of s.sets) {
    if (!items.some((i) => i.exercise_id === x.exercise_id)) {
      items.push(extra({ id: x.exercise_id, name: x.name, name_en: x.name_en, kind: x.kind, step: 2.5 }));
    }
  }
  const w: Workout = {
    uid, dayId: s.program_day_id, dayName: s.day_name ?? "", kind: s.kind, easy: !!base?.easy,
    startedAt: s.started, items, done, restUntil: null, restTotal: 0,
  };
  keep(w);
  return w;
}

/** Упражнение не из программы: добавили на ходу. */
export function extra(e: { id: number; name: string; name_en: string; kind: "strength" | "time"; step: number }): WItem {
  const time = e.kind === "time";
  return {
    exercise_id: e.id, name: e.name, name_en: e.name_en, kind: e.kind, step: e.step,
    sets: time ? 2 : 3, reps_min: time ? 30 : 8, reps_max: time ? 60 : 12, rir: 2, rest: time ? 60 : 120,
    weight: null, reps: time ? 30 : 8,
  };
}

export const doneFor = (w: Workout, exerciseId: number) =>
  w.done.filter((d) => d.exercise_id === exerciseId);

export const workDone = (w: Workout, exerciseId: number) =>
  doneFor(w, exerciseId).filter((d) => !d.warm).length;

/** С чего начать следующий подход: вес как в предыдущем сегодня, иначе — цель дня,
    иначе — что было в прошлый раз. Повторы — цель дня. */
export function nextSet(w: Workout, item: WItem): { weight: number; reps: number } {
  const mine = doneFor(w, item.exercise_id).filter((d) => !d.warm);
  const weight = mine.length ? mine[mine.length - 1].weight : item.weight ?? item.last?.[0]?.weight ?? 0;
  return { weight, reps: item.reps };
}

/** Первое упражнение, где ещё не сделаны все подходы; всё сделано — последнее. */
export function cursorOf(w: Workout): number {
  const i = w.items.findIndex((it) => workDone(w, it.exercise_id) < it.sets);
  return i === -1 ? Math.max(0, w.items.length - 1) : i;
}

export const allDone = (w: Workout) =>
  w.items.length > 0 && w.items.every((it) => workDone(w, it.exercise_id) >= it.sets);

/** Шаг кнопок «плюс-минус» у веса. У упражнений со своим весом шага прибавки нет — берём килограмм. */
export function bump(value: number, step: number, dir: 1 | -1): number {
  const s = step > 0 ? step : 1;
  return Math.max(0, Math.round((value + dir * s) * 100) / 100);
}

export function addSet(w: Workout, item: WItem, weight: number, reps: number, warm: boolean, now = Date.now()): Workout {
  const d: DoneSet = { uid: newUid(), exercise_id: item.exercise_id, weight, reps, warm, at: now };
  push({ t: "set", sess: w.uid, uid: d.uid, body: { exercise_id: d.exercise_id, weight, reps, warm, uid: d.uid, at: now } });
  // После разминочного подхода отдыхать по таймеру незачем.
  const next: Workout = { ...w, done: [...w.done, d], restUntil: warm ? null : now + item.rest * 1000, restTotal: warm ? 0 : item.rest };
  keep(next);
  return next;
}

export function editSet(w: Workout, uid: string, weight: number, reps: number): Workout {
  push({ t: "edit", uid, body: { weight, reps } });
  const next = { ...w, done: w.done.map((d) => (d.uid === uid ? { ...d, weight, reps } : d)) };
  keep(next);
  return next;
}

export function removeSet(w: Workout, uid: string): Workout {
  push({ t: "del", uid });
  const next = { ...w, done: w.done.filter((d) => d.uid !== uid) };
  keep(next);
  return next;
}

export function addItem(w: Workout, item: WItem): Workout {
  if (w.items.some((i) => i.exercise_id === item.exercise_id)) return w;
  const next = { ...w, items: [...w.items, item] };
  keep(next);
  return next;
}

export function rest(w: Workout, until: number | null, total = w.restTotal): Workout {
  const next = { ...w, restUntil: until, restTotal: total };
  keep(next);
  return next;
}

export interface Summary { minutes: number; sets: number; volume: number; exercises: number }

export function summary(w: Workout, now = Date.now()): Summary {
  const work = w.done.filter((d) => !d.warm);
  const strength = new Set(w.items.filter((i) => i.kind === "strength").map((i) => i.exercise_id));
  return {
    minutes: Math.max(1, Math.round((now - w.startedAt) / 60000)),
    sets: work.length,
    volume: Math.round(work.filter((d) => strength.has(d.exercise_id)).reduce((a, d) => a + d.weight * d.reps, 0)),
    exercises: new Set(work.map((d) => d.exercise_id)).size,
  };
}

/** Забыл закрыть и вернулся на другой день: концом считаем последний подход, а не «сейчас». */
const STALE = 2 * 3600 * 1000;

export function endedAt(w: Workout, now = Date.now()): number {
  const last = w.done.reduce((m, d) => Math.max(m, d.at), w.startedAt);
  return now - last > STALE ? last + 60000 : now;
}

export function finish(w: Workout, feel: number | null, note: string, now = Date.now()): void {
  push({ t: "finish", sess: w.uid, body: { feel, note: note || null, at: endedAt(w, now) } });
  keep(null);
}

/** Бросить тренировку, не записывая. Ещё не ушла на сервер — вынимаем из очереди всё её,
    уже ушла — просим удалить. */
export function discard(w: Workout): void {
  const mine = (op: Op) => (op.t === "start" ? op.uid : "sess" in op ? op.sess : "") === w.uid;
  const unsent = outbox().some((op) => op.t === "start" && op.uid === w.uid);
  keep(null);
  if (unsent) {
    save(OUTBOX, outbox().filter((op) => !mine(op)));
    listeners.forEach((f) => f());
  } else {
    push({ t: "drop", sess: w.uid });
  }
}

// ── Очередь ──

const outbox = (): Op[] => load<Op[]>(OUTBOX, []);
const ids = (): Record<string, number> => load<Record<string, number>>(IDS, {});

function rememberId(uid: string, id: number): void {
  const m = ids();
  if (m[uid] === id) return;
  // Метки нужны, пока очередь разбирается; полсотни последних хватает с запасом.
  const keys = Object.keys(m);
  if (keys.length > 400) keys.slice(0, 200).forEach((k) => delete m[k]);
  m[uid] = id;
  save(IDS, m);
}

export const serverId = (uid: string): number | undefined => ids()[uid];

const listeners = new Set<() => void>();
/** Очередь изменилась — для значка «ждут связи» и для итога тренировки. */
export function onQueue(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

export const pending = () => outbox().length;

function push(op: Op): void {
  save(OUTBOX, [...outbox(), op]);
  listeners.forEach((f) => f());
  void flush();
}

type Send = <T>(method: string, url: string, body?: unknown) => Promise<T>;

async function run(op: Op, send: Send): Promise<void> {
  const learn = (s: Session) => s.sets.forEach((x) => x.uid && rememberId(x.uid, x.id));
  if (op.t === "start") {
    rememberId(op.uid, (await send<Session>("POST", "/fit/sessions", op.body)).id);
    return;
  }
  if (op.t === "set" || op.t === "finish" || op.t === "drop") {
    const sid = serverId(op.sess);
    if (sid === undefined) return;          // тренировка не завелась — её подходам некуда идти
    if (op.t === "set") learn(await send<Session>("POST", `/fit/sessions/${sid}/sets`, op.body));
    else if (op.t === "finish") await send<Session>("POST", `/fit/sessions/${sid}/finish`, op.body);
    else await send<unknown>("DELETE", `/fit/sessions/${sid}`);
    return;
  }
  const id = serverId(op.uid);
  if (id === undefined) return;
  if (op.t === "edit") await send<Session>("PATCH", `/fit/sets/${id}`, op.body);
  else await send<Session>("DELETE", `/fit/sets/${id}`);
}

let flushing: Promise<void> | null = null;

/** Отправить очередь по порядку. Обрыв связи — остановиться и ждать; отказ сервера —
    выбросить запрос: повтором его не исправить, а очередь он запер бы навсегда. */
export function flush(send: Send = req): Promise<void> {
  if (flushing) return flushing;
  const going = (async () => {
    for (;;) {
      const [op] = outbox();
      if (!op) return;
      try {
        await run(op, send);
      } catch (e) {
        if (!(e instanceof HttpError) || e.status === 401 || e.status >= 500) return;
      }
      // Пока шёл запрос, в очередь могли дописать — убираем именно первый, а не затираем всё.
      save(OUTBOX, outbox().slice(1));
      listeners.forEach((f) => f());
    }
  })().finally(() => { if (flushing === going) flushing = null; });
  // Присваиваем после запуска: пустая очередь завершает проход сразу, и сброс в finally
  // не должен успеть раньше самого присваивания — иначе очередь встала бы навсегда.
  flushing = going;
  return going;
}

/** Подтолкнуть очередь, когда связь вернулась или приложение снова на экране. */
export function watchQueue(): () => void {
  const kick = () => { if (pending()) void flush(); };
  const timer = setInterval(kick, 15000);
  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", kick);
  kick();
  return () => {
    clearInterval(timer);
    window.removeEventListener("online", kick);
    document.removeEventListener("visibilitychange", kick);
  };
}
