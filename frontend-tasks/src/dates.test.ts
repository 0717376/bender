import { afterEach, describe, expect, it, vi } from "vitest";
import { iso, isoShift, isoToday } from "./dates";

// Скрипт теста запускается с TZ=Europe/Moscow: именно там ломался прежний
// вариант на toISOString() — с полуночи до 03:00 он отдавал вчерашний день.
describe("dates", () => {
  afterEach(() => vi.useRealTimers());

  it("формат — YYYY-MM-DD с ведущими нулями", () => {
    expect(iso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("ночью после полуночи «сегодня» — уже новый день", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 26, 1, 30)); // 26 июля, 01:30 по местному
    expect(isoToday()).toBe("2026-07-26");
  });

  it("вечером «сегодня» — тот же день", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 26, 23, 30));
    expect(isoToday()).toBe("2026-07-26");
  });

  it("сдвиг на день переходит через границу месяца", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 12, 0));
    expect(isoShift(1)).toBe("2026-08-01");
    expect(isoShift(-1)).toBe("2026-07-30");
  });
});
