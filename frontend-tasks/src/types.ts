export interface RepeatRule {
  unit: "day" | "week" | "month" | "year";
  interval: number;
  mode: "schedule" | "done"; // schedule: от даты задачи; done: от даты выполнения
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
  tags: string[];
  sort: number;
  repeat?: RepeatRule | null;
  kind?: "task" | "heading";
  completed_at?: string | null;
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
