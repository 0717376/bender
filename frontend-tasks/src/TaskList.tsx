import { useMemo, useState } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ChevronDown, ChevronRight, ListPlus, Plus, Trash2 } from "lucide-react";
import TaskRow from "./TaskRow";
import { projectColor } from "./colors";
import { MONTHS, doneOfTotal, locale, logbookStats, t } from "./i18n";
import type { Area, Project, Task } from "./types";
import { isOverdue, type Sel } from "./useTasks";

const DRAGGABLE_VIEWS = new Set(["today", "inbox", "anytime", "someday"]);

const EMPTY: Record<string, string> = {
  today: t("empty_today"),
  inbox: t("empty_inbox"),
  upcoming: t("empty_upcoming"),
  anytime: t("empty_anytime"),
  someday: t("empty_someday"),
  logbook: t("empty_logbook"),
  project: t("empty_project"),
  tag: t("empty_tag"),
};

interface Ops {
  patch: (id: number, body: Record<string, unknown>) => void;
  remove: (id: number, title: string) => void;
  toggle: (t: Task) => void;
  checkAdd: (taskId: number, title: string) => void;
  checkToggle: (taskId: number, itemId: number, done: boolean) => void;
  checkRemove: (taskId: number, itemId: number) => void;
  beginEdit: (id: number) => void;
  endEdit: () => void;
}

const KICKERS: Record<string, string> = {
  inbox: t("kicker_inbox"),
  upcoming: t("kicker_upcoming"),
  anytime: t("kicker_anytime"),
  someday: t("kicker_someday"),
};

const isoToday = () => new Date().toISOString().slice(0, 10);

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

/** Group label for an upcoming date: Tomorrow / "Thu, July 4" (7 days) / "July" / "July 2027". */
function upcomingLabel(iso: string): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(iso + "T00:00:00");
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (days === 1) return t("tomorrow");
  if (days <= 7) return cap(d.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "long" }));
  const m = MONTHS[d.getMonth()];
  return d.getFullYear() === today.getFullYear() ? m : `${m} ${d.getFullYear()}`;
}

/** Group label for the logbook: Today / Yesterday / "June 28" / "June 28 2025". */
function logbookLabel(iso: string): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(iso + "T00:00:00");
  const days = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (days === 0) return t("view_today");
  if (days === 1) return t("yesterday");
  const s = d.toLocaleDateString(locale, { day: "numeric", month: "long" });
  return d.getFullYear() === today.getFullYear() ? s : `${s} ${d.getFullYear()}`;
}

/** Sections = consecutive runs of tasks sharing a group label. */
function sections(tasks: Task[], labelOf: (t: Task) => string): { label: string; tasks: Task[] }[] {
  const out: { label: string; tasks: Task[] }[] = [];
  for (const t of tasks) {
    const label = labelOf(t);
    if (out.length && out[out.length - 1].label === label) out[out.length - 1].tasks.push(t);
    else out.push({ label, tasks: [t] });
  }
  return out;
}

/** In-place rename for project/area view headers: an input styled as the h1. */
function TitleEdit({ value, onSave }: { value: string; onSave: (title: string) => void }) {
  const [v, setV] = useState(value);
  const commit = () => { const s = v.trim(); if (s && s !== value) onSave(s); else setV(value); };
  return (
    <input
      className="h1-edit"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") { setV(value); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

function Ring({ done, open }: { done: number; open: number }) {
  const total = done + open;
  if (!total) return null;
  const r = 14, c = 2 * Math.PI * r;
  return (
    <div className="ring-wrap" title={doneOfTotal(done, total)}>
      <svg width="36" height="36" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r={r} className="ring-bg" />
        <circle cx="18" cy="18" r={r} className="ring-fg" strokeDasharray={`${(done / total) * c} ${c}`} transform="rotate(-90 18 18)" />
      </svg>
      <span className="ring-num">{done}</span>
    </div>
  );
}

export default function TaskList({
  view,
  tasks,
  doneTasks,
  completing,
  projects,
  areas,
  ops,
  entering,
  loading,
  expandedId,
  onExpand,
  onNewTask,
  onAddHeading,
  onRenameView,
  onDeleteArea,
  onOpenProject,
  progress,
  onTag,
  activeId,
  previewTodayId,
  focusId,
}: {
  view: Sel;
  tasks: Task[];
  doneTasks: Task[];
  completing: Set<number>;
  entering: Set<number>;
  loading: boolean;
  projects: Project[];
  areas: Area[];
  ops: Ops;
  expandedId: number | null;
  onExpand: (id: number | null) => void;
  onNewTask: () => void;
  onAddHeading: (title: string) => void;
  onRenameView: (title: string) => void;
  onDeleteArea: () => void;
  onOpenProject: (id: number) => void;
  progress: Record<number, { open: number; total: number }>;
  onTag: (tag: string) => void;
  activeId: number | null;
  previewTodayId: number | null;
  focusId: number | null;
}) {
  const [doneOpen, setDoneOpen] = useState(() => localStorage.getItem("tasks_log_open") === "1");
  const toggleDone = () => setDoneOpen((v) => {
    localStorage.setItem("tasks_log_open", v ? "0" : "1");
    return !v;
  });
  const [addingHead, setAddingHead] = useState(false);
  const [headTitle, setHeadTitle] = useState("");

  const isProject = view.kind === "project";
  const isArea = view.kind === "area";
  const isToday = view.kind === "view" && view.key === "today";
  const isUpcoming = view.kind === "view" && view.key === "upcoming";
  const isLogbook = view.kind === "view" && view.key === "logbook";
  const draggable = isProject || isArea || (view.kind === "view" && DRAGGABLE_VIEWS.has(view.key));

  const emptyMsg = isProject ? EMPTY.project : isArea ? t("empty_area")
    : view.kind === "tag" ? EMPTY.tag : EMPTY[view.key] ?? t("empty_generic");

  // Weekly/monthly stats for the logbook kicker.
  const logStats = useMemo(() => {
    if (!isLogbook) return "";
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const mondayISO = monday.toISOString().slice(0, 10);
    const monthISO = isoToday().slice(0, 7);
    const week = tasks.filter((t) => (t.completed_at ?? "") >= mondayISO).length;
    const month = tasks.filter((t) => (t.completed_at ?? "").startsWith(monthISO)).length;
    return logbookStats(week, month);
  }, [isLogbook, tasks]);

  const project = isProject ? projects.find((p) => p.id === view.id) : null;
  const projArea = project?.area_id != null ? areas.find((a) => a.id === project.area_id) : null;
  const areaProjects = isArea ? projects.filter((p) => p.area_id === view.id) : [];

  const kicker = isProject ? (projArea ? `${t("project")} · ${projArea.title}` : t("project"))
    : isArea ? t("area")
    : view.kind === "tag" ? t("tag")
    : isToday ? todayLabel()
    : isLogbook ? (logStats || t("kicker_logbook"))
    : KICKERS[view.key] ?? "";

  const today = isoToday();
  // A task mid-drag from Overdue previews as a member of the Today group.
  const overdue = isToday ? tasks.filter((t) => isOverdue(t, today) && t.id !== previewTodayId) : [];
  const onTime = isToday ? tasks.filter((t) => !overdue.includes(t)) : tasks;

  const row = (t: Task, drag: boolean) => (
    <TaskRow
      key={t.id}
      task={t}
      expanded={expandedId === t.id}
      completing={completing.has(t.id)}
      entering={entering.has(t.id)}
      dragging={activeId === t.id}
      draggable={drag}
      focused={focusId === t.id}
      projects={projects}
      areas={areas}
      ops={ops}
      onExpand={onExpand}
      onTag={onTag}
    />
  );

  const submitHeading = () => {
    const t = headTitle.trim();
    setHeadTitle("");
    setAddingHead(false);
    if (t) onAddHeading(t);
  };

  return (
    <main className="list-pane">
      <div className="list-scroll scroll">
        <div className="list-head">
          <div className="head-text">
            {kicker && <div className="kicker">{kicker}</div>}
            {isProject || isArea
              ? <TitleEdit key={`${view.kind}:${view.id}:${view.label}`} value={view.label} onSave={onRenameView} />
              : <h1>{view.label}</h1>}
          </div>
          {(isToday || isProject) && <Ring done={doneTasks.length} open={tasks.filter((t) => t.kind !== "heading").length} />}
          {isProject && (
            <div className="head-actions">
              <button className="head-btn" onClick={() => setAddingHead(true)}>
                <ListPlus size={13} strokeWidth={2} />{t("add_heading")}
              </button>
            </div>
          )}
          {isArea && (
            <div className="head-actions">
              <button className="head-btn" onClick={onDeleteArea}>
                <Trash2 size={13} strokeWidth={2} />{t("delete")}
              </button>
            </div>
          )}
        </div>

        {areaProjects.length > 0 && (
          <ul className="area-projects">
            {areaProjects.map((p) => {
              const pr = progress[p.id] ?? { open: 0, total: 0 };
              const color = projectColor(p.id);
              const r = 6.5, c = 2 * Math.PI * r;
              const done = Math.max(0, pr.total - pr.open);
              return (
                <li key={p.id}>
                  <button className="ap-row" onClick={() => onOpenProject(p.id)}>
                    {pr.total > 0 ? (
                      <svg width="18" height="18" viewBox="0 0 18 18">
                        <circle cx="9" cy="9" r={r} fill="none" stroke={color} strokeOpacity="0.28" strokeWidth="2.6" />
                        <circle cx="9" cy="9" r={r} fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round"
                          strokeDasharray={`${(done / pr.total) * c} ${c}`} transform="rotate(-90 9 9)" />
                      </svg>
                    ) : (
                      <span className="ap-dot" style={{ background: color }} />
                    )}
                    <span className="ap-title">{p.title}</span>
                    {pr.open > 0 && <span className="ap-count">{pr.open}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {tasks.length === 0 && !addingHead ? (
          loading ? <div className="list-loading" /> : areaProjects.length === 0 && <div className="empty">{emptyMsg}</div>
        ) : (
          <ul className="tasks">
            {isToday ? (
              // Two contexts, one per group: row shifting stays inside its group instead of
              // sliding across the static headers; cross-group moves transfer via onDragOver.
              <>
                {overdue.length > 0 && (
                  <>
                    <li className="group-head danger">{t("overdue")}</li>
                    <SortableContext items={overdue.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                      {overdue.map((t) => row(t, draggable))}
                    </SortableContext>
                    {onTime.length > 0 && <li className="group-head">{t("view_today")}</li>}
                  </>
                )}
                <SortableContext items={onTime.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                  {onTime.map((t) => row(t, draggable))}
                </SortableContext>
              </>
            ) : (
              <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                {isUpcoming || isLogbook
                  ? sections(onTime, (t) => (isUpcoming ? upcomingLabel(t.when_date ?? today) : logbookLabel(t.completed_at ?? today))).map((s) => (
                      <li key={s.label} className="group-li">
                        <div className="group-head">{s.label}</div>
                        <ul className="tasks">{s.tasks.map((t) => row(t, false))}</ul>
                      </li>
                    ))
                  : onTime.map((t) => row(t, draggable))}
              </SortableContext>
            )}
          </ul>
        )}

        {addingHead && (
          <form className="h-add" onSubmit={(e) => { e.preventDefault(); submitHeading(); }}>
            <input
              autoFocus
              placeholder={t("heading_name")}
              value={headTitle}
              onChange={(e) => setHeadTitle(e.target.value)}
              onBlur={submitHeading}
              onKeyDown={(e) => { if (e.key === "Escape") { setHeadTitle(""); setAddingHead(false); } }}
            />
          </form>
        )}

        {(isToday || isProject) && doneTasks.length > 0 && (
          <div className="done-block">
            <button className="done-toggle" onClick={toggleDone}>
              {doneOpen ? <ChevronDown size={14} strokeWidth={2.2} /> : <ChevronRight size={14} strokeWidth={2.2} />}
              {isProject ? t("view_logbook") : t("done_today")}
              <span className="count">{doneTasks.length}</span>
            </button>
            {doneOpen && (isProject
              ? sections(doneTasks, (t) => logbookLabel(t.completed_at ?? today)).map((s) => (
                  <div key={s.label} className="group-li">
                    <div className="group-head">{s.label}</div>
                    <ul className="tasks">{s.tasks.map((t) => row(t, false))}</ul>
                  </div>
                ))
              : <ul className="tasks">{doneTasks.map((t) => row(t, false))}</ul>)}
          </div>
        )}
      </div>

      {view.key !== "logbook" && (
        <button className="fab" onClick={onNewTask} aria-label={t("new_task")}>
          <Plus size={24} strokeWidth={2.2} />
        </button>
      )}

    </main>
  );
}

function todayLabel(): string {
  return new Date().toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
}
