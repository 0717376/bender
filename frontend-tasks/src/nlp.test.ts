import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTitle, stripMatch } from "./nlp";

// Пятница, 24 июля 2026, полдень — фиксируем, иначе «в пятницу» плавает.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 24, 12, 0));
});
afterEach(() => vi.useRealTimers());

describe("parseTitle", () => {
  it("понимает «завтра» и «послезавтра»", () => {
    expect(parseTitle("купить хлеб завтра")).toMatchObject({ when: "2026-07-25", matched: "завтра" });
    expect(parseTitle("созвон послезавтра")).toMatchObject({ when: "2026-07-26" });
  });

  it("«сегодня» и «когда-нибудь» отдаёт словами, не датой", () => {
    expect(parseTitle("позвонить сегодня")).toMatchObject({ when: "today" });
    expect(parseTitle("выучить греческий когда-нибудь")).toMatchObject({ when: "someday" });
  });

  it("день недели ищет строго в будущем", () => {
    // сегодня пятница — «в пятницу» это через неделю, а не сейчас
    expect(parseTitle("баня в пятницу")).toMatchObject({ when: "2026-07-31" });
    expect(parseTitle("в понедельник к врачу")).toMatchObject({ when: "2026-07-27" });
  });

  it("«через N ...» считает от сегодня", () => {
    expect(parseTitle("прививка через 2 недели")).toMatchObject({ when: "2026-08-07" });
    expect(parseTitle("напомнить через неделю")).toMatchObject({ when: "2026-07-31" });
  });

  it("даты словами и цифрами", () => {
    expect(parseTitle("отчёт 15 августа")).toMatchObject({ when: "2026-08-15" });
    expect(parseTitle("оплатить 03.09")).toMatchObject({ when: "2026-09-03" });
  });

  it("прошедшую дату переносит на следующий год", () => {
    expect(parseTitle("подарок 10 января")).toMatchObject({ when: "2027-01-10" });
  });

  it("повторы", () => {
    expect(parseTitle("зарядка каждый день")).toMatchObject({
      repeat: { unit: "day", interval: 1, mode: "schedule" },
    });
    expect(parseTitle("отчёт каждые 2 недели")).toMatchObject({
      repeat: { unit: "week", interval: 2, mode: "schedule" },
    });
  });

  it("день недели в повторе становится правилом «по вторникам»", () => {
    expect(parseTitle("бассейн каждый вторник")).toMatchObject({
      repeat: { unit: "week", interval: 1, weekdays: [2] },
      when: "2026-07-28",
    });
  });

  it("перечисление дней недели", () => {
    expect(parseTitle("english по вторникам и четвергам")).toMatchObject({
      repeat: { unit: "week", interval: 1, weekdays: [2, 4] },
      when: "2026-07-28", // ближайший из перечисленных
    });
    expect(parseTitle("зал по пн, ср, пт")).toMatchObject({
      repeat: { weekdays: [1, 3, 5] },
    });
  });

  it("«по» без дней недели за повтор не считается", () => {
    expect(parseTitle("позвонить по работе")).toBeNull();
  });

  it("«каждое 15 число» — правило по числу месяца", () => {
    expect(parseTitle("оплатить квартиру каждое 15 число")).toMatchObject({
      repeat: { unit: "month", interval: 1, monthday: 15 },
    });
  });

  it("без подсказки возвращает null", () => {
    expect(parseTitle("просто задача")).toBeNull();
  });
});

describe("stripMatch", () => {
  it("вырезает фрагмент и подчищает хвосты", () => {
    const hint = parseTitle("купить хлеб завтра")!;
    expect(stripMatch("купить хлеб завтра", hint.matched)).toBe("купить хлеб");
  });

  it("не оставляет двойных пробелов и запятой в конце", () => {
    expect(stripMatch("позвонить завтра, маме", "завтра")).toBe("позвонить , маме");
  });
});
