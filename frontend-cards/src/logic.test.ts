import { describe, expect, it } from "vitest";
import { parseRoute, routeHash } from "./App";
import { numbers, pieces, plain, wrap } from "./cloze";
import { interval, spent } from "./fmt";
import { plural, pluralForm } from "./i18n";
import { level, weeks } from "./Stats";

describe("cloze", () => {
  const text = "Столица {{c1::Франции}} — {{c2::Париж::город}}";

  it("разбирает пропуски и подсказки", () => {
    expect(pieces(text)).toEqual([
      { text: "Столица " }, { n: 1, answer: "Франции", hint: "" },
      { text: " — " }, { n: 2, answer: "Париж", hint: "город" },
    ]);
    expect(numbers(text)).toEqual([1, 2]);
    expect(plain(text)).toBe("Столица Франции — Париж");
  });

  it("оборачивает выделение в следующий по счёту пропуск", () => {
    expect(wrap("вода кипит при 100 градусах", 15, 18)).toBe("вода кипит при {{c1::100}} градусах");
    expect(wrap("{{c3::a}} b", 10, 11)).toBe("{{c3::a}} {{c4::b}}");
    expect(wrap("abc", 2, 2)).toBe("abc");
  });
});

describe("fmt", () => {
  it("интервал до следующего показа", () => {
    expect(interval(30)).toBe("<1 мин");
    expect(interval(600)).toBe("10 мин");
    expect(interval(3 * 3600)).toBe("3 ч");
    expect(interval(5 * 86400)).toBe("5 д");
    expect(interval(75 * 86400)).toBe("2,5 мес");
    expect(interval(730 * 86400)).toBe("2 г");
  });

  it("потраченное время", () => {
    expect(spent(45_000)).toBe("45 сек");
    expect(spent(12 * 60_000)).toBe("12 мин");
    expect(spent(80 * 60_000)).toBe("1 ч 20 мин");
  });
});

describe("i18n", () => {
  it("русские формы числа", () => {
    expect([1, 2, 5, 11, 21, 22, 25, 111].map(pluralForm)).toEqual([0, 1, 2, 2, 0, 1, 2, 2]);
    expect(plural(21, "cards")).toBe("21 карточка");
    expect(plural(3, "streak_days", true)).toBe("дня подряд");
  });
});

describe("stats", () => {
  it("недели идут с понедельника и не выходят за окно", () => {
    // 2026-10-07 — среда, 2026-10-10 — суббота
    expect(weeks("2026-10-07", "2026-10-10")).toEqual([
      [null, null, "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", null],
    ]);
    const half = weeks("2026-04-12", "2026-10-10");
    expect(half.flat().filter(Boolean)).toHaveLength(182);
    expect(half.every((col) => col.length === 7)).toBe(true);
  });

  it("ступени насыщенности", () => {
    expect([0, 1, 10, 20, 30, 40].map((n) => level(n, 40))).toEqual([0, 1, 1, 2, 3, 4]);
  });
});

describe("route", () => {
  it("адрес разбирается и собирается обратно", () => {
    for (const hash of ["#/", "#/review", "#/review/3", "#/cards", "#/cards/inbox", "#/cards/leech", "#/stats"]) {
      expect(routeHash(parseRoute(hash))).toBe(hash);
    }
    expect(parseRoute("")).toEqual({ page: "home" });
    expect(parseRoute("#/cards/чушь")).toEqual({ page: "cards", filter: "all" });
  });
});
