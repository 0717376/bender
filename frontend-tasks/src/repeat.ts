import { iso, isoToday } from "./dates";
import type { RepeatRule } from "./types";

/* Расчёт дат повтора — зеркало backend/app/repeat.py. Дублирование сознательное:
   редактор показывает ближайшие даты на каждый щелчок переключателя, и гонять
   ради этого запрос на сервер значит показывать предпросмотр с задержкой. */

const parse = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const shift = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
/** ISO-номер дня недели: понедельник = 1, воскресенье = 7. */
const isoDay = (d: Date) => d.getDay() || 7;
const daysBetween = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 86400000);
const lastDay = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
const floorDiv = (a: number, b: number) => Math.floor(a / b);

/** Дата внутри месяца: число, «последний день» или «второй вторник». null — такого дня нет. */
function monthSlot(y: number, m: number, rule: RepeatRule, start: Date): Date | null {
  const last = lastDay(y, m);
  if (rule.nth) {
    const [ordinal, weekday] = rule.nth;
    const gap = (weekday - isoDay(new Date(y, m, 1)) + 7) % 7;
    if (ordinal === -1) return new Date(y, m, 1 + gap + Math.floor((last - 1 - gap) / 7) * 7);
    const d = 1 + gap + (ordinal - 1) * 7;
    return d > last ? null : new Date(y, m, d);
  }
  const md = rule.monthday ?? start.getDate();
  return new Date(y, m, md === "last" ? last : Math.min(md, last));
}

/** Даты строго после `after` и не позже `until`, не больше `limit` штук. */
export function occurrences(rule: RepeatRule, after: string, until: string, limit = 3): string[] {
  if (!rule || limit <= 0 || rule.mode === "done") return [];
  const start = parse(rule.start || after);
  let stop = parse(until);
  const on = rule.end && "on" in rule.end ? rule.end.on : null;
  if (on && parse(on) < stop) stop = parse(on);
  const lo = parse(after);
  const step = Math.max(1, rule.interval);
  const out: string[] = [];

  if (rule.unit === "day") {
    let d = shift(start, Math.max(0, floorDiv(daysBetween(lo, start), step) + 1) * step);
    while (d <= stop && out.length < limit) {
      out.push(iso(d));
      d = shift(d, step);
    }
    return out;
  }

  if (rule.unit === "week") {
    const days = rule.weekdays?.length ? [...rule.weekdays].sort((a, b) => a - b) : [isoDay(start)];
    const anchor = shift(start, -(isoDay(start) - 1)); // понедельник недели старта
    const loMonday = shift(lo, -(isoDay(lo) - 1));
    const k = Math.max(0, floorDiv(floorDiv(daysBetween(loMonday, anchor), 7), step));
    let week = shift(anchor, k * step * 7);
    while (week <= stop && out.length < limit) {
      for (const wd of days) {
        const d = shift(week, wd - 1);
        if (d >= start && d <= stop && d > lo) {
          out.push(iso(d));
          if (out.length >= limit) break;
        }
      }
      week = shift(week, step * 7);
    }
    return out;
  }

  // месяц и год — один шаг по месяцам, у года он просто длиннее и месяц фиксирован
  const months = rule.unit === "month" ? step : step * 12;
  const base = start.getFullYear() * 12 + ((rule.month ? rule.month - 1 : start.getMonth()));
  const cur = lo.getFullYear() * 12 + lo.getMonth();
  let i = base + Math.max(0, floorDiv(cur - base, months)) * months;
  while (out.length < limit) {
    const y = Math.floor(i / 12), m = i % 12;
    if (y > 9000 || new Date(y, m, 1) > stop) break;
    const d = monthSlot(y, m, rule, start);
    if (d && d >= start && d <= stop && d > lo) out.push(iso(d));
    i += months;
  }
  return out;
}

/** Ближайшие даты повтора начиная с сегодняшнего дня — для предпросмотра в редакторе. */
export function nextDates(rule: RepeatRule, count = 3): string[] {
  const today = parse(isoToday());
  const from = rule.start && rule.start > isoToday() ? shift(parse(rule.start), -1) : shift(today, -1);
  return occurrences(rule, iso(from), iso(new Date(today.getFullYear() + 5, today.getMonth(), today.getDate())), count);
}

/** Правило по умолчанию для только что включённого повтора. */
export const defaultRule = (unit: RepeatRule["unit"] = "week"): RepeatRule => {
  const d = parse(isoToday());
  const rule: RepeatRule = { unit, interval: 1, mode: "schedule", start: isoToday() };
  if (unit === "week") rule.weekdays = [isoDay(d)];
  if (unit === "month") rule.monthday = d.getDate();
  if (unit === "year") { rule.month = d.getMonth() + 1; rule.monthday = d.getDate(); }
  return rule;
};
