import type { RepeatRule } from "./types";

/** Lightweight RU natural-language date/repeat detection for the quick-entry title.
    Returns the matched fragment so the UI can show a hint and strip it on create. */
export interface ParsedHint {
  when?: string;          // ISO | "today" | "someday"
  repeat?: RepeatRule;
  matched: string;        // the exact text fragment that produced the hint
  label: string;          // human label for the hint chip
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const plusDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
};

// Weekday → JS getDay() index. Multiple colloquial forms per day.
const WEEKDAYS: [RegExp, number][] = [
  [/\b(в\s+)?(понедельник|пн)\b/iu, 1],
  [/\b(во\s+)?(вторник|вт)\b/iu, 2],
  [/\b(в\s+)?(среду|среда|ср)\b/iu, 3],
  [/\b(в\s+)?(четверг|чт)\b/iu, 4],
  [/\b(в\s+)?(пятницу|пятница|пт)\b/iu, 5],
  [/\b(в\s+)?(субботу|суббота|сб)\b/iu, 6],
  [/\b(в\s+)?(воскресенье|вс)\b/iu, 0],
];

const WEEKDAY_LABELS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

/** Next strictly-future occurrence of a weekday. */
function nextWeekday(target: number): string {
  const d = new Date();
  const diff = (target - d.getDay() + 7) % 7 || 7;
  return plusDays(diff);
}

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

const UNIT_RE: [RegExp, RepeatRule["unit"]][] = [
  [/^(день|дня|дней|дн)/iu, "day"],
  [/^(недел)/iu, "week"],
  [/^(месяц|мес)/iu, "month"],
  [/^(год|года|лет)/iu, "year"],
];

function unitOf(word: string): RepeatRule["unit"] | null {
  for (const [re, u] of UNIT_RE) if (re.test(word)) return u;
  return null;
}

const fmtDM = (isoDate: string) => {
  const [, m, d] = isoDate.split("-").map(Number);
  return `${d} ${MONTHS_GEN[m - 1]}`;
};

export function parseTitle(text: string): ParsedHint | null {
  let m: RegExpMatchArray | null;

  // --- Repeat: «каждый день», «каждую неделю», «каждые 3 дня», «каждый вторник» ---
  m = text.match(/\bкажд(?:ый|ую|ое|ые)\s+(?:(\d+)\s+)?([а-яё]+)/iu);
  if (m) {
    const n = m[1] ? parseInt(m[1], 10) : 1;
    const unit = unitOf(m[2]);
    if (unit) {
      const repeat: RepeatRule = { unit, interval: Math.max(1, n), mode: "schedule" };
      return { repeat, matched: m[0], label: `повтор: ${m[0].toLowerCase()}` };
    }
    for (const [re, day] of WEEKDAYS) {
      if (re.test(m[2])) {
        const when = nextWeekday(day);
        return {
          when,
          repeat: { unit: "week", interval: 1, mode: "schedule" },
          matched: m[0],
          label: `каждый ${WEEKDAY_LABELS[day]} · с ${fmtDM(when)}`,
        };
      }
    }
  }

  // --- Simple day words ---
  m = text.match(/\bпослезавтра\b/iu);
  if (m) return { when: plusDays(2), matched: m[0], label: `послезавтра · ${fmtDM(plusDays(2))}` };
  m = text.match(/\bзавтра\b/iu);
  if (m) return { when: plusDays(1), matched: m[0], label: `завтра · ${fmtDM(plusDays(1))}` };
  m = text.match(/\bсегодня\b/iu);
  if (m) return { when: "today", matched: m[0], label: "сегодня" };
  m = text.match(/\bкогда-нибудь\b/iu);
  if (m) return { when: "someday", matched: m[0], label: "когда-нибудь" };

  // --- «через N дней/недель/месяцев», «через неделю» ---
  m = text.match(/\bчерез\s+(?:(\d+)\s+)?([а-яё]+)/iu);
  if (m) {
    const n = m[1] ? parseInt(m[1], 10) : 1;
    const unit = unitOf(m[2]);
    if (unit) {
      const days = unit === "day" ? n : unit === "week" ? n * 7 : unit === "month" ? n * 30 : n * 365;
      const when = plusDays(days);
      return { when, matched: m[0], label: `${m[0].toLowerCase()} · ${fmtDM(when)}` };
    }
  }

  // --- Weekday alone: «в пятницу», «пн» (short forms only as separate word) ---
  for (const [re, day] of WEEKDAYS) {
    m = text.match(re);
    if (m) {
      const when = nextWeekday(day);
      return { when, matched: m[0], label: `${WEEKDAY_LABELS[day]} · ${fmtDM(when)}` };
    }
  }

  // --- «15 июля» ---
  m = text.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS_GEN.join("|")})\\b`, "iu"));
  if (m) {
    const day = parseInt(m[1], 10);
    const month = MONTHS_GEN.indexOf(m[2].toLowerCase());
    if (day >= 1 && day <= 31 && month >= 0) {
      const now = new Date();
      let d = new Date(now.getFullYear(), month, day);
      if (iso(d) < iso(now)) d = new Date(now.getFullYear() + 1, month, day);
      return { when: iso(d), matched: m[0], label: fmtDM(iso(d)) };
    }
  }

  // --- «15.07» / «15.07.2026» ---
  m = text.match(/\b(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\b/u);
  if (m) {
    const day = parseInt(m[1], 10), month = parseInt(m[2], 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const now = new Date();
      let d = new Date(m[3] ? parseInt(m[3], 10) : now.getFullYear(), month - 1, day);
      if (!m[3] && iso(d) < iso(now)) d = new Date(now.getFullYear() + 1, month - 1, day);
      return { when: iso(d), matched: m[0], label: fmtDM(iso(d)) };
    }
  }

  return null;
}

/** Remove the matched fragment (and a dangling preposition/extra space) from the title. */
export function stripMatch(title: string, matched: string): string {
  return title.replace(matched, " ").replace(/\s{2,}/gu, " ").trim().replace(/[,\s]+$/u, "");
}
