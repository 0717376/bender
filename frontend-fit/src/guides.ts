import { useSyncExternalStore } from "react";
import { api } from "./api";
import { lang, type Lang } from "./i18n";
import type { Exercise, Guide } from "./types";

/** Техника и картинки к упражнениям. Справочник целиком лежит в localStorage: карточку
    открывают в зале, а связи там может не быть. Картинки на тот же случай держит сервис-воркер. */
const KEY = "fit_guides";

export interface Info { image: string; guide: Guide; guide_en: Guide }
export type Book = Record<number, Info>;

export const GUIDE_KEYS = ["find", "setup", "focus", "avoid"] as const;

const read = (): Book => {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
};
let book = read();
let fresh = 0;
const subs = new Set<() => void>();
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };

/** Из справочника — только то, что есть что показать. */
export function pack(all: Pick<Exercise, "id" | "image" | "guide" | "guide_en">[]): Book {
  const out: Book = {};
  for (const e of all) {
    if (e.image || Object.keys(e.guide ?? {}).length) out[e.id] = { image: e.image, guide: e.guide, guide_en: e.guide_en };
  }
  return out;
}

/** Перечитать справочник, но не чаще раза в минуту: зовут при каждом открытии карточки. */
export async function refreshGuides(now = Date.now()): Promise<void> {
  if (now - fresh < 60_000) return;
  fresh = now;
  try {
    book = pack(await api.exercises());
    localStorage.setItem(KEY, JSON.stringify(book));
    subs.forEach((fn) => fn());
  } catch { fresh = 0; }
}

export const useBook = (): Book => useSyncExternalStore(subscribe, () => book);

/** Текст на языке интерфейса; чего по-английски нет (писал ассистент) — берём как есть. */
export const guideText = (i: Info, l: Lang = lang): Guide => (l === "en" ? { ...i.guide, ...i.guide_en } : i.guide);

export const frame = (image: string, n: 0 | 1): string => `/ex/${image}-${n}.webp`;

/** Заранее скачать кадры: дома сеть есть, а в зале они откроются из кэша. */
export function warm(ids: number[]): void {
  for (const id of ids) {
    const image = book[id]?.image;
    if (image) for (const n of [0, 1] as const) new Image().src = frame(image, n);
  }
}
