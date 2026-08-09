export type RepeatUnit = "day" | "week" | "month" | "year";
/** Порядковый номер дня недели в месяце: 1–4 или -1 («последний вторник»). */
export type RepeatNth = [number, number];
export type RepeatEnd = { after: number } | { on: string };

export interface RepeatRule {
  unit: RepeatUnit;
  interval: number;
  mode: "schedule" | "done"; // schedule: по календарю; done: через N после выполнения
  weekdays?: number[];       // ISO 1–7, только для недели: «по вт и чт»
  monthday?: number | "last"; // месяц/год: число или последний день
  nth?: RepeatNth;            // месяц/год: «второй вторник» (вместо monthday)
  month?: number;             // год: 1–12
  start?: string;             // ISO — с какой даты считаем
  end?: RepeatEnd;            // когда прекратить
}

export interface ChecklistItem {
  id: number;
  title: string;
  done: boolean;
  sort: number;
}

export interface Task {
  id: number;
  title: string;
  notes: string;
  status: string;
  project_id: number | null;
  area_id: number | null;
  when_date: string | null;
  deadline: string | null;
  someday: boolean;
  triaged: boolean;
  tags: string[];
  sort: number;
  repeat?: RepeatRule | null;
  // Повтор живёт на шаблоне (kind='repeat'), задачи-копии ссылаются на него.
  repeat_parent?: number | null;
  next_date?: string | null; // шаблон: дата ближайшей открытой копии
  kind?: "task" | "heading" | "repeat";
  completed_at?: string | null;
  created_at?: string;
  // Slip count: how many times a due/overdue task was pushed to a later date.
  moves?: number;
  // Present on list rows (aggregate); full array only on a single-task fetch.
  checklist_total?: number;
  checklist_done?: number;
  checklist?: ChecklistItem[];
}

export interface Project {
  id: number;
  title: string;
  notes: string;
  status: string;
  area_id: number | null;
}

export interface Area {
  id: number;
  title: string;
}

export interface Progress {
  open: number;
  total: number;
}

export interface Overview {
  counts: Record<string, number>;
  projects: Project[];
  areas: Area[];
  progress: Record<string, Progress>; // keyed by project id
}
