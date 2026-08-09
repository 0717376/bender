import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRule, nextDates, occurrences } from "./repeat";
import type { RepeatRule } from "./types";

// Те же случаи, что и в backend/tests/test_repeat.py: расчёт дублируется в двух
// местах ради мгновенного предпросмотра, и разъехаться он не должен.
const rule = (r: Partial<RepeatRule>): RepeatRule =>
  ({ unit: "day", interval: 1, mode: "schedule", ...r }) as RepeatRule;

describe("occurrences", () => {
  it("каждый день", () => {
    expect(occurrences(rule({ start: "2026-03-01" }), "2026-03-01", "2026-03-04")).toEqual([
      "2026-03-02", "2026-03-03", "2026-03-04"]);
  });

  it("каждые 3 дня держат сетку от старта", () => {
    expect(occurrences(rule({ interval: 3, start: "2026-03-01" }), "2026-03-05", "2026-03-12")).toEqual([
      "2026-03-07", "2026-03-10"]);
  });

  it("по вторникам и четвергам", () => {
    expect(occurrences(rule({ unit: "week", weekdays: [2, 4], start: "2026-03-02" }), "2026-03-02", "2026-03-13", 4))
      .toEqual(["2026-03-03", "2026-03-05", "2026-03-10", "2026-03-12"]);
  });

  it("через неделю по понедельникам", () => {
    expect(occurrences(rule({ unit: "week", interval: 2, weekdays: [1], start: "2026-03-02" }), "2026-03-02", "2026-04-14"))
      .toEqual(["2026-03-16", "2026-03-30", "2026-04-13"]);
  });

  it("31 число прижимается к длине месяца", () => {
    expect(occurrences(rule({ unit: "month", monthday: 31, start: "2026-01-31" }), "2026-01-31", "2026-04-30"))
      .toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("последний день месяца", () => {
    expect(occurrences(rule({ unit: "month", monthday: "last", start: "2026-01-01" }), "2026-01-01", "2026-03-31"))
      .toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("второй вторник месяца", () => {
    expect(occurrences(rule({ unit: "month", nth: [2, 2], start: "2026-01-01" }), "2026-01-01", "2026-03-31"))
      .toEqual(["2026-01-13", "2026-02-10", "2026-03-10"]);
  });

  it("последняя пятница месяца", () => {
    expect(occurrences(rule({ unit: "month", nth: [-1, 5], start: "2026-01-01" }), "2026-01-01", "2026-02-28"))
      .toEqual(["2026-01-30", "2026-02-27"]);
  });

  it("раз в год в фиксированную дату", () => {
    expect(occurrences(rule({ unit: "year", month: 3, monthday: 12, start: "2026-01-01" }), "2026-01-01", "2028-12-31"))
      .toEqual(["2026-03-12", "2027-03-12", "2028-03-12"]);
  });

  it("«до даты» обрезает хвост", () => {
    expect(occurrences(rule({ start: "2026-03-01", end: { on: "2026-03-03" } }), "2026-03-01", "2026-03-10"))
      .toEqual(["2026-03-02", "2026-03-03"]);
  });

  it("«через N после выполнения» календаря не имеет", () => {
    expect(occurrences(rule({ interval: 3, mode: "done" }), "2026-03-01", "2026-04-01")).toEqual([]);
  });
});

describe("nextDates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0)); // пятница, 24 июля 2026
  });
  afterEach(() => vi.useRealTimers());

  it("считает от сегодня и включает сегодняшний день", () => {
    expect(nextDates(rule({ start: "2026-07-01" }), 3)).toEqual(["2026-07-24", "2026-07-25", "2026-07-26"]);
  });

  it("правило с будущим стартом начинается со старта", () => {
    expect(nextDates(rule({ unit: "week", weekdays: [1], start: "2026-08-03" }), 2)).toEqual([
      "2026-08-03", "2026-08-10"]);
  });

  it("правило по умолчанию совпадает с сегодняшним днём", () => {
    expect(defaultRule("week").weekdays).toEqual([5]); // пятница
    expect(defaultRule("month").monthday).toBe(24);
    expect(defaultRule("year")).toMatchObject({ month: 7, monthday: 24 });
  });
});
