import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./api";
import { parseRoute } from "./App";
import { layout } from "./Chart";
import { clock, dayLabel, hours, restText, sessionTitle, setText } from "./fmt";
import { frame, guideText, pack } from "./guides";
import { plural, pluralForm } from "./i18n";
import {
  addItem, addSet, allDone, begin, bump, current, cursorOf, discard, editSet, endedAt, extra, finish, flush,
  nextSet, pending, removeSet, serverId, summary, workDone,
} from "./live";
import { ago } from "./SettingsModal";
import { planMinutes, targetText } from "./Today";
import type { PlanDay, PlanItem } from "./types";

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  id: 1, exercise_id: 10, name: "Жим лёжа", name_en: "Bench press", muscle: "chest", kind: "strength", step: 2.5,
  sets: 3, reps_min: 6, reps_max: 10, rir: 2, rest: 120, note: "", weight: 80, reps: 8, hint: "hold",
  last: [{ weight: 80, reps: 7 }], last_day: "2026-01-05", ...over,
});
const plan = (items: PlanItem[] = [item(), item({ id: 2, exercise_id: 11, name: "Тяга", sets: 2, weight: null, last: [] })]): PlanDay =>
  ({ id: 5, name: "А", kind: "strength", minutes: 0, note: "", items });

const T0 = Date.UTC(2026, 0, 5, 15);

/** Сервер понарошку: помнит запросы и выдаёт номера. */
function server() {
  const calls: [string, string, unknown][] = [];
  let n = 100;
  const sets: { id: number; uid: string }[] = [];
  const send = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    calls.push([method, url, body]);
    const b = (body ?? {}) as { uid?: string };
    if (method === "POST" && url === "/fit/sessions") return { id: 7, sets: [] } as T;
    if (method === "POST" && url.endsWith("/sets")) sets.push({ id: ++n, uid: b.uid! });
    return { id: 7, sets } as T;
  };
  return { calls, send };
}

beforeEach(async () => {
  // Сети в тестах нет: очередь копится, пока её не отправят явно.
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));
  await flush();
  localStorage.clear();
});

describe("тренировка в телефоне", () => {
  it("начинается с целями дня и переживает перезагрузку", () => {
    const w = begin(plan(), T0);
    expect(w.items.map((i) => i.name)).toEqual(["Жим лёжа", "Тяга"]);
    expect(current()?.uid).toBe(w.uid);
    expect(pending()).toBe(1);
  });

  it("следующий подход: вес как в предыдущем, повторы по цели", () => {
    let w = begin(plan(), T0);
    const [bench, row] = w.items;
    expect(nextSet(w, bench)).toEqual({ weight: 80, reps: 8 });
    expect(nextSet(w, row)).toEqual({ weight: 0, reps: 8 });
    w = addSet(w, bench, 82.5, 7, false, T0 + 1000);
    expect(nextSet(w, bench)).toEqual({ weight: 82.5, reps: 8 });
  });

  it("разминка не считается подходом и не запускает отдых", () => {
    let w = begin(plan(), T0);
    w = addSet(w, w.items[0], 40, 10, true, T0);
    expect(workDone(w, 10)).toBe(0);
    expect(w.restUntil).toBeNull();
    expect(nextSet(w, w.items[0]).weight).toBe(80);
    w = addSet(w, w.items[0], 80, 8, false, T0 + 5000);
    expect(w.restUntil).toBe(T0 + 5000 + 120000);
  });

  it("ведёт по упражнениям и знает, когда всё сделано", () => {
    let w = begin(plan(), T0);
    expect(cursorOf(w)).toBe(0);
    for (let i = 0; i < 3; i++) w = addSet(w, w.items[0], 80, 8, false, T0 + i);
    expect(cursorOf(w)).toBe(1);
    expect(allDone(w)).toBe(false);
    for (let i = 0; i < 2; i++) w = addSet(w, w.items[1], 50, 10, false, T0 + 10 + i);
    expect(allDone(w)).toBe(true);
    expect(cursorOf(w)).toBe(1);
  });

  it("правит и убирает подходы, добавляет упражнение один раз", () => {
    let w = begin(plan(), T0);
    w = addSet(w, w.items[0], 80, 8, false, T0);
    w = editSet(w, w.done[0].uid, 82.5, 6);
    expect(w.done[0]).toMatchObject({ weight: 82.5, reps: 6 });
    w = removeSet(w, w.done[0].uid);
    expect(w.done).toEqual([]);
    const plank = extra({ id: 50, name: "Планка", name_en: "Plank", kind: "time", step: 0 });
    w = addItem(addItem(w, plank), plank);
    expect(w.items).toHaveLength(3);
    expect(w.items[2]).toMatchObject({ sets: 2, reps: 30, rest: 60 });
  });

  it("итог считает объём только по силовым и без разминки", () => {
    let w = begin(plan([item(), item({ id: 3, exercise_id: 50, kind: "time", name: "Планка" })]), T0);
    w = addSet(w, w.items[0], 40, 10, true, T0);
    w = addSet(w, w.items[0], 80, 8, false, T0);
    w = addSet(w, w.items[1], 0, 60, false, T0);
    expect(summary(w, T0 + 45 * 60000)).toEqual({ minutes: 45, sets: 2, volume: 640, exercises: 2 });
  });

  it("забытую тренировку заканчивает последним подходом, а не «сейчас»", () => {
    let w = begin(plan(), T0);
    w = addSet(w, w.items[0], 80, 8, false, T0 + 30 * 60000);
    expect(endedAt(w, T0 + 40 * 60000)).toBe(T0 + 40 * 60000);
    expect(endedAt(w, T0 + 20 * 3600000)).toBe(T0 + 31 * 60000);
  });

  it("шаг веса: по упражнению, не ниже нуля, со своим весом — по килограмму", () => {
    expect(bump(80, 2.5, 1)).toBe(82.5);
    expect(bump(1, 2.5, -1)).toBe(0);
    expect(bump(0, 0, 1)).toBe(1);
    expect(bump(17.5, 1.25, 1)).toBe(18.75);
  });
});

describe("очередь без связи", () => {
  it("копит действия и отправляет по порядку, когда связь вернулась", async () => {
    let w = begin(plan(), T0);
    w = addSet(w, w.items[0], 80, 8, false, T0 + 1);
    w = addSet(w, w.items[0], 80, 7, false, T0 + 2);
    w = editSet(w, w.done[1].uid, 80, 8);
    w = removeSet(w, w.done[0].uid);
    finish(w, 4, "ок", T0 + 3);
    await flush();
    expect(pending()).toBe(6);
    expect(current()).toBeNull();

    const { calls, send } = server();
    await flush(send);
    expect(pending()).toBe(0);
    expect(calls.map(([m, u]) => `${m} ${u}`)).toEqual([
      "POST /fit/sessions", "POST /fit/sessions/7/sets", "POST /fit/sessions/7/sets",
      "PATCH /fit/sets/102", "DELETE /fit/sets/101", "POST /fit/sessions/7/finish",
    ]);
    expect(calls[0][2]).toMatchObject({ program_day_id: 5, at: T0 });
    expect(calls[5][2]).toMatchObject({ feel: 4, note: "ок", at: T0 + 3 });
    expect(serverId(w.uid)).toBe(7);
  });

  it("обрыв посреди очереди — остаток ждёт, отправленное не повторяется", async () => {
    let w = begin(plan(), T0);
    w = addSet(w, w.items[0], 80, 8, false, T0);
    await flush();
    const { calls, send } = server();
    let alive = true;
    await flush(async (m, u, b) => { if (!alive) throw new TypeError("offline"); alive = false; return send(m, u, b); });
    expect(pending()).toBe(1);
    await flush(send);
    expect(calls.map(([m, u]) => `${m} ${u}`)).toEqual(["POST /fit/sessions", "POST /fit/sessions/7/sets"]);
  });

  it("отказ сервера выбрасывает запрос, а сбой сервера — нет", async () => {
    const w = begin(plan(), T0);
    addSet(w, w.items[0], 80, 8, false, T0);
    await flush();
    const { send } = server();
    await flush(async (m, u, b) => { if (u.endsWith("/sets")) throw new HttpError(503, "busy"); return send(m, u, b); });
    expect(pending()).toBe(1);
    await flush(async (m, u, b) => { if (u.endsWith("/sets")) throw new HttpError(400, "bad"); return send(m, u, b); });
    expect(pending()).toBe(0);
  });

  it("брошенная тренировка: неотправленная исчезает, отправленная удаляется", async () => {
    let w = begin(plan(), T0);
    w = addSet(w, w.items[0], 80, 8, false, T0);
    await flush();
    discard(w);
    expect(pending()).toBe(0);
    expect(current()).toBeNull();

    w = begin(plan(), T0);
    await flush();
    const { calls, send } = server();
    await flush(send);
    discard(w);
    await flush();
    await flush(send);
    expect(calls.map(([m, u]) => `${m} ${u}`)).toEqual(["POST /fit/sessions", "DELETE /fit/sessions/7"]);
  });
});

describe("подписи", () => {
  it("подход, отдых, часы", () => {
    expect(setText(82.5, 8)).toBe("82,5 × 8");
    expect(setText(0, 12)).toBe("12");
    expect(setText(0, 45, "time")).toBe("45 с");
    expect(setText(20, 40, "time")).toBe("20 кг · 40 с");
    expect(restText(120)).toBe("2 мин");
    expect(restText(90)).toBe("1,5 мин");
    expect(restText(45)).toBe("45 с");
    expect(clock(245000)).toBe("4:05");
    expect(clock(3845000)).toBe("1:04:05");
    expect(hours(26400)).toBe("7 ч 20 мин");
    expect(hours(1500)).toBe("25 мин");
  });

  it("день относительно сегодняшнего", () => {
    expect(dayLabel("2026-03-01", "2026-03-01")).toBe("сегодня");
    expect(dayLabel("2026-02-28", "2026-03-01")).toBe("вчера");
    expect(dayLabel("2026-02-12", "2026-03-01")).toBe("12 февр");
    expect(dayLabel("2025-12-31", "2026-03-01")).toContain("2025");
  });

  it("название тренировки: день программы, запись кольца, вид", () => {
    const s = { title: "", day_name: null, kind: "cardio" as const, source: "manual" };
    expect(sessionTitle({ ...s, day_name: "А" })).toBe("А");
    expect(sessionTitle({ ...s, source: "oura", title: "running" })).toBe("Бег");
    expect(sessionTitle({ ...s, source: "oura", title: "strengthTraining" })).toBe("Силовая");
    expect(sessionTitle({ ...s, source: "oura", title: "rock_climbing" })).toBe("Rock climbing");
    expect(sessionTitle(s)).toBe("Кардио");
  });

  it("цель и длительность дня", () => {
    expect(targetText(item())).toBe("3 × 80 кг × 8");
    expect(targetText(item({ weight: null }))).toBe("3 × 6–10");
    expect(targetText(item({ kind: "time", reps: 40 }))).toBe("3 × 40 с");
    expect(planMinutes(plan())).toBe(15);
    expect(planMinutes({ ...plan(), minutes: 30 })).toBe(30);
  });

  it("числительные и давность", () => {
    expect([1, 2, 5, 11, 21, 104].map(pluralForm)).toEqual([0, 1, 2, 2, 0, 1]);
    expect(plural(3, "sets")).toBe("3 подхода");
    expect(plural(5, "workouts", true)).toBe("тренировок");
    const now = 1_000_000_000_000;
    expect(ago(now / 1000 - 20, now)).toBe("только что");
    expect(ago(now / 1000 - 600, now)).toBe("10 мин назад");
    expect(ago(now / 1000 - 3 * 3600, now)).toBe("3 ч назад");
    expect(ago(now / 1000 - 3 * 86400, now)).toBe("3 дн назад");
  });

  it("адрес экрана", () => {
    expect(parseRoute("")).toBe("home");
    expect(parseRoute("#/workout")).toBe("workout");
    expect(parseRoute("#/settings")).toBe("settings");
    expect(parseRoute("#/что-то")).toBe("home");
  });
});

describe("график", () => {
  it("ось x — дни, а не номера точек", () => {
    const { pts } = layout([{ day: "2026-01-01", y: 100 }, { day: "2026-01-02", y: 102 }, { day: "2026-01-11", y: 110 }], 170);
    expect(pts[1].x - pts[0].x).toBeCloseTo((pts[2].x - pts[0].x) / 10);
    expect(pts[2].y).toBeLessThan(pts[0].y);
  });

  it("ровная линия не прилипает к краю, одна точка — посередине", () => {
    const flat = layout([{ day: "2026-01-01", y: 80 }, { day: "2026-01-08", y: 80 }], 170);
    expect(flat.pts[0].y).toBeGreaterThan(40);
    expect(flat.pts[0].y).toBeLessThan(130);
    const one = layout([{ day: "2026-01-01", y: 80 }], 170);
    expect(Number.isFinite(one.pts[0].x) && Number.isFinite(one.pts[0].y)).toBe(true);
  });
});

describe("техника", () => {
  const ex = { id: 7, image: "plank", guide: { find: "Коврики наверху", setup: "Локти под плечами" }, guide_en: { setup: "Elbows under shoulders" } };

  it("в справочник идёт только то, что есть что показать", () => {
    expect(Object.keys(pack([ex, { id: 8, image: "", guide: {}, guide_en: {} }]))).toEqual(["7"]);
    expect(frame("plank", 1)).toBe("/ex/plank-1.webp");
  });

  it("строка без перевода показывается как записана", () => {
    const info = pack([ex])[7];
    expect(guideText(info, "ru")).toEqual(ex.guide);
    expect(guideText(info, "en")).toEqual({ find: "Коврики наверху", setup: "Elbows under shoulders" });
  });
});
