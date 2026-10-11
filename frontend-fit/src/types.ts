export type Kind = "strength" | "cardio" | "swim" | "other";
export type Hint = "new" | "up" | "hold" | "down";
export type Level = "go" | "easy" | "rest";

export interface Exercise {
  id: number;
  name: string;
  name_en: string;
  muscle: string;
  also: string[];
  equipment: string;
  kind: "strength" | "time";
  step: number;
  archived: boolean;
}

/** Строка дня программы; с целями на сегодня — когда пришла из плана. */
export interface PlanItem {
  id: number;
  exercise_id: number;
  name: string;
  name_en: string;
  muscle: string;
  kind: "strength" | "time";
  step: number;
  sets: number;
  reps_min: number;
  reps_max: number;
  rir: number;
  rest: number;
  note: string;
  weight?: number | null;
  reps?: number;
  hint?: Hint;
  last?: { weight: number; reps: number }[];
  last_day?: string | null;
}

export interface PlanDay {
  id: number;
  name: string;
  kind: Kind;
  minutes: number;
  note: string;
  easy?: boolean;
  items: PlanItem[];
}

export interface Program {
  id: number;
  name: string;
  goal: string;
  note: string;
  days: PlanDay[];
}

export interface SetRow {
  id: number;
  uid: string | null;
  exercise_id: number;
  name: string;
  name_en: string;
  muscle: string;
  kind: "strength" | "time";
  weight: number;
  reps: number;
  rir: number | null;
  warm: boolean;
}

export interface Record_ {
  exercise_id: number;
  name: string;
  name_en: string;
  e1rm: number;
  prev: number;
  weight: number;
  reps: number;
}

export interface Session {
  id: number;
  day: string;
  started: number;
  ended: number | null;
  kind: Kind;
  program_day_id: number | null;
  day_name: string | null;
  title: string;
  note: string;
  feel: number | null;
  source: "manual" | "oura";
  distance: number | null;
  calories: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  minutes: number | null;
  work_sets: number;
  volume: number;
  sets: SetRow[];
  records?: Record_[];
}

export interface Week {
  from: string;
  to: string;
  sessions: number;
  minutes: number;
  work_sets: number;
  by_kind: Partial<Record<Kind, number>>;
  days: Record<string, Kind[]>;
  sets: Record<string, number>;
}

export interface OuraDay {
  day: string;
  readiness: number | null;
  sleep_score: number | null;
  activity: number | null;
  hrv: number | null;
  rhr: number | null;
  temp_dev: number | null;
  sleep_sec: number | null;
  deep_sec: number | null;
  rem_sec: number | null;
  efficiency: number | null;
  steps: number | null;
  stress_sec: number | null;
  resilience: string | null;
  vo2max: number | null;
}

export interface Signal {
  key: "readiness" | "sleep" | "temp" | "hrv" | "rhr";
  value: number;
  state: "ok" | "warn" | "bad";
  base?: number;
}

export interface Recovery {
  day: string;
  level: Level | null;
  signals: Signal[];
  data: OuraDay | null;
  days?: OuraDay[];
}

export interface BodyRow { day: string; weight: number; note: string }

export interface Overview {
  day: string;
  program: { id: number; name: string; goal: string; days: { id: number; name: string; kind: Kind }[] } | null;
  active: Session | null;
  next: PlanDay | null;
  recovery: Recovery;
  today: Session[];
  week: Week;
  body: BodyRow | null;
  profile: Record<string, string | number>;
}

export interface Settings {
  notify: boolean;
  notify_hour: number;
  oura_min_minutes: number;
  weekly: boolean;
  profile: Record<string, string | number>;
}

export interface OuraStatus {
  configured: boolean;
  connected: boolean;
  synced: number | null;
  error: string;
}

export interface Progress {
  exercise: Exercise;
  points: { day: string; e1rm: number; weight: number; reps: number; volume: number; sets: number }[];
  best: { day: string; e1rm: number; weight: number; reps: number } | null;
}
