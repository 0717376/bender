import { lang } from "./i18n";

const U = lang === "ru"
  ? { m: "мин", h: "ч", d: "д", mo: "мес", y: "г" }
  : { m: "m", h: "h", d: "d", mo: "mo", y: "y" };
const sep = lang === "ru" ? " " : "";
const num = (x: number) => (lang === "ru" ? String(x).replace(".", ",") : String(x));

/** Интервал до следующего показа: «10 мин», «3 д», «2,5 мес» — подпись на кнопке оценки. */
export function interval(secs: number): string {
  if (secs < 60) return `<1${sep}${U.m}`;
  const m = secs / 60, h = m / 60, d = h / 24;
  if (m < 60) return `${Math.round(m)}${sep}${U.m}`;
  if (h < 24) return `${Math.round(h)}${sep}${U.h}`;
  if (d < 30) return `${Math.round(d)}${sep}${U.d}`;
  if (d < 365) return `${num(Math.round(d / 3.04) / 10)}${sep}${U.mo}`;
  return `${num(Math.round(d / 36.5) / 10)}${sep}${U.y}`;
}

/** Сколько времени ушло: «45 сек», «12 мин», «1 ч 20 мин». */
export function spent(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return lang === "ru" ? `${s} сек` : `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}${sep}${U.m}`;
  return `${Math.floor(m / 60)}${sep}${U.h}` + (m % 60 ? ` ${m % 60}${sep}${U.m}` : "");
}

/** Когда карточка придёт: сегодня — словом, дальше — интервалом от сейчас. */
export function dueIn(due: number | null, now = Date.now()): string {
  if (due == null) return "";
  return interval(Math.max(0, (due - now) / 1000));
}
