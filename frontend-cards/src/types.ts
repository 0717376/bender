export type Kind = "word" | "basic" | "cloze";
export type Fields = Record<string, string | boolean | undefined>;

/** Состояния карточки у планировщика: новая, заучивается, выучена, забыта и доучивается. */
export const NEW = 0, LEARNING = 1, REVIEW = 2, RELEARNING = 3;

export interface Counts { learning: number; review: number; new: number; total: number }

export interface Deck {
  id: number; name: string; descr: string; new_per_day: number; retention: number;
  counts: Counts; cards: number;
}

export interface CardState {
  id: number; note_id: number; tpl: string; state: number; due: number | null;
  stability: number | null; reps: number; lapses: number;
  suspended: boolean; leech: boolean; last_review: number | null;
}

export interface Card extends CardState {
  kind: Kind; fields: Fields; source: Record<string, string>; tags: string[];
  deck_id: number; deck: string; front: string; back: string;
  /** Через сколько секунд карточка вернётся при оценке 1…4. */
  intervals: Record<string, number>;
}

export interface Note {
  id: number; deck_id: number; kind: Kind; fields: Fields; source: Record<string, string>;
  tags: string[]; status: "ready" | "draft" | "failed"; error: string;
  created: number; updated: number; cards?: CardState[];
}

export interface Session { card: Card | null; counts: Counts; waiting: number | null }

export interface Overview {
  due: Counts; waiting: number | null; decks: Deck[];
  streak: { current: number; best: number };
  today: { n: number; again: number; ms: number };
  forecast: { day: string; n: number }[];
  inbox: number; leeches: number;
}

export interface Stats {
  today: string; from: string;
  days: { day: string; n: number; again: number; ms: number }[];
  streak: { current: number; best: number };
  totals: { reviews: number; ms: number; days: number };
  retention: { seen: number; kept: number; rate: number | null };
  maturity: { new: number; learning: number; young: number; mature: number; suspended: number };
  forecast: { day: string; n: number }[];
}

export interface Settings { notify: boolean; notify_hour: number; new_per_day: number; retention: number }
