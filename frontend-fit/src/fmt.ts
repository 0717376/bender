import { lang, locale, t } from "./i18n";
import type { Kind } from "./types";

/** «82,5» — без хвостовых нулей, с запятой по-русски. */
export const num = (n: number, digits = 1): string =>
  n.toLocaleString(locale, { maximumFractionDigits: digits });

export const kg = (n: number): string => `${num(n, 2)} ${t("u_kg")}`;

/** Подход одной строкой: «80 × 8», «12» для своего веса, «45 с» для планки. */
export function setText(weight: number, reps: number, kind: "strength" | "time" = "strength"): string {
  if (kind === "time") return weight ? `${num(weight, 2)} ${t("u_kg")} · ${reps} ${t("u_sec")}` : `${reps} ${t("u_sec")}`;
  return weight ? `${num(weight, 2)} × ${reps}` : String(reps);
}

/** Секунды сна и стресса: «7 ч 20 мин». */
export function hours(sec: number): string {
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h} ${t("u_h")} ${String(m % 60).padStart(2, "0")} ${t("u_min")}` : `${m} ${t("u_min")}`;
}

export const mins = (m: number): string => `${m} ${t("u_min")}`;

/** Таймер: «4:05», а после часа — «1:04:05». */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export const km = (meters: number): string => `${num(meters / 1000, meters < 10000 ? 2 : 1)} ${t("u_km")}`;

/** Отдых между подходами: «2 мин», «1,5 мин», «45 с». */
export const restText = (sec: number): string =>
  sec >= 60 ? `${num(sec / 60)} ${t("u_min")}` : `${sec} ${t("u_sec")}`;

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** «сегодня», «вчера», «12 окт», а в прошлых годах — с годом. today — день по счёту сервера. */
export function dayLabel(day: string, today: string): string {
  if (day === today) return t("today");
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const [ty, tm, td] = today.split("-").map(Number);
  if (iso(new Date(ty, tm - 1, td - 1)) === day) return t("yesterday");
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", ...(y !== ty ? { year: "numeric" } : {}) })
    .replace(".", "");
}

/** Название упражнения на языке интерфейса. */
export const exName = (e: { name: string; name_en: string }): string =>
  lang === "en" && e.name_en ? e.name_en : e.name;

const ACTIVITY: Record<string, [string, string]> = {
  walking: ["Ходьба", "Walking"], running: ["Бег", "Running"], cycling: ["Велосипед", "Cycling"],
  swimming: ["Плавание", "Swimming"], hiking: ["Поход", "Hiking"], yoga: ["Йога", "Yoga"],
  strength_training: ["Силовая", "Strength training"], elliptical: ["Эллипсоид", "Elliptical"],
  rowing: ["Гребля", "Rowing"], dancing: ["Танцы", "Dancing"], pilates: ["Пилатес", "Pilates"],
  hiit: ["Интервальная", "HIIT"], skiing: ["Лыжи", "Skiing"], tennis: ["Теннис", "Tennis"],
  football: ["Футбол", "Football"], stretching: ["Растяжка", "Stretching"],
};

/** Чем была тренировка: день программы, своё название, а у записи кольца — вид активности. */
export function sessionTitle(s: { title: string; day_name: string | null; kind: Kind; source: string }): string {
  if (s.day_name) return s.day_name;
  if (s.source === "oura" && s.title) {
    const key = s.title.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    const hit = ACTIVITY[key];
    if (hit) return hit[lang === "ru" ? 0 : 1];
    return key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
  return s.title || t(`kind_${s.kind}`);
}
