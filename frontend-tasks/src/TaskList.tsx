import { useMemo, useState } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ChevronDown, ChevronRight, Layers, ListPlus, Plus } from "lucide-react";
import { MenuPopover } from "./Popover";
import TaskRow from "./TaskRow";
import type { Area, Project, Task } from "./types";
import type { Sel } from "./useTasks";

const DRAGGABLE_VIEWS = new Set(["today", "inbox", "anytime", "someday"]);

const EMPTY: Record<string, string> = {
  today: "На сегодня ничего не запланировано.",
  inbox: "Входящие пусты. Сюда попадают задачи без проекта и даты.",
  upcoming: "Нет предстоящих задач с датой.",
  anytime: "Нет задач «когда-нибудь».",
  someday: "Список «когда-то потом» пуст.",
  logbook: "Журнал пуст.",
  project: "В проекте пока нет задач.",
  tag: "Нет открытых задач с этим тегом.",
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
  inbox: "Несортированные мысли",
  upcoming: "Календарь",
  anytime: "Всё, что можно сделать",
  someday: "Может быть, однажды",
};

const isoToday = () => new Date().toISOString().slice(0, 10);

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

/** Group label for an upcoming date: Завтра / «чт, 4 июля» (7 days) / «Июль» / «Июль 2027». */
function upcomingLabel(iso: string): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(iso + "T00:00:00");
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (days === 1) return "Завтра";
  if (days <= 7) return cap(d.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "long" }));
  const m = cap(MONTHS[d.getMonth()]);
  return d.getFullYear() === today.getFullYear() ? m : `${m} ${d.getFullYear()}`;
}

/** Group label for the logbook: Сегодня / Вчера / «28 июня» / «28 июня 2025». */
function logbookLabel(iso: string): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(iso + "T00:00:00");
  const days = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (days === 0) return "Сегодня";
  if (days === 1) return "Вчера";
  const s = d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
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

function Ring({ done, open }: { done: number; open: number }) {
  const total = done + open;
  if (!total) return null;
  const r = 14, c = 2 * Math.PI * r;
  return (
    <div className="ring-wrap" title={`Готово ${done} из ${total}`}>
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
  onSetArea,
  onTag,
  activeId,
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
  onSetArea: (areaId: number | null) => void;
  onTag: (tag: string) => void;
  activeId: number | null;
  focusId: number | null;
}) {
  const [doneOpen, setDoneOpen] = useState(() => localStorage.getItem("tasks_log_open") === "1");
  const toggleDone = () => setDoneOpen((v) => {
    localStorage.setItem("tasks_log_open", v ? "0" : "1");
    return !v;
  });
  const [addingHead, setAddingHead] = useState(false);
  const [headTitle, setHeadTitle] = useState("");
  const [areaPop, setAreaPop] = useState<DOMRect | null>(null);

  const isProject = view.kind === "project";
  const isToday = view.kind === "view" && view.key === "today";
  const isUpcoming = view.kind === "view" && view.key === "upcoming";
  const isLogbook = view.kind === "view" && view.key === "logbook";
  const draggable = isProject || (view.kind === "view" && DRAGGABLE_VIEWS.has(view.key));

  const emptyMsg = isProject ? EMPTY.project : view.kind === "tag" ? EMPTY.tag : EMPTY[view.key] ?? "Пусто";

  // Weekly/monthly stats for the logbook kicker.
  const logStats = useMemo(() => {
    if (!isLogbook) return "";
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const mondayISO = monday.toISOString().slice(0, 10);
    const monthISO = isoToday().slice(0, 7);
    const week = tasks.filter((t) => (t.completed_at ?? "") >= mondayISO).length;
    const month = tasks.filter((t) => (t.completed_at ?? "").startsWith(monthISO)).length;
    return `${week} за неделю · ${month} за месяц`;
  }, [isLogbook, tasks]);

  const kicker = isProject ? "Проект"
    : view.kind === "tag" ? "Тег"
    : isToday ? todayLabel()
    : isLogbook ? (logStats || "Всё, что ты завершил")
    : KICKERS[view.key] ?? "";

  const project = isProject ? projects.find((p) => p.id === view.id) : null;
  const projArea = project?.area_id != null ? areas.find((a) => a.id === project.area_id) : null;

  const today = isoToday();
  const overdue = isToday ? tasks.filter((t) => (t.when_date && t.when_date < today) || (t.deadline && t.deadline < today)) : [];
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
            <h1>{view.label}</h1>
          </div>
          {(isToday || isProject) && <Ring done={doneTasks.length} open={tasks.filter((t) => t.kind !== "heading").length} />}
          {isProject && (
            <div className="head-actions">
              <button className="head-btn" onClick={(e) => { const rect = e.currentTarget.getBoundingClientRect(); setAreaPop((c) => (c ? null : rect)); }}>
                <Layers size={13} strokeWidth={2} />{projArea ? projArea.title : "Область"}
              </button>
              <button className="head-btn" onClick={() => setAddingHead(true)}>
                <ListPlus size={13} strokeWidth={2} />Раздел
              </button>
            </div>
          )}
        </div>

        {tasks.length === 0 && !addingHead ? (
          loading ? <div className="list-loading" /> : <div className="empty">{emptyMsg}</div>
        ) : (
          <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <ul className="tasks">
              {isToday && overdue.length > 0 && (
                <>
                  <li className="group-head danger">Просрочено</li>
                  {overdue.map((t) => row(t, draggable))}
                  {onTime.length > 0 && <li className="group-head">Сегодня</li>}
                </>
              )}

              {isUpcoming || isLogbook
                ? sections(onTime, (t) => (isUpcoming ? upcomingLabel(t.when_date ?? today) : logbookLabel(t.completed_at ?? today))).map((s) => (
                    <li key={s.label} className="group-li">
                      <div className="group-head">{s.label}</div>
                      <ul className="tasks">{s.tasks.map((t) => row(t, false))}</ul>
                    </li>
                  ))
                : onTime.map((t) => row(t, draggable))}
            </ul>
          </SortableContext>
        )}

        {addingHead && (
          <form className="h-add" onSubmit={(e) => { e.preventDefault(); submitHeading(); }}>
            <input
              autoFocus
              placeholder="Название раздела"
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
              {isProject ? "Журнал" : "Готово сегодня"}
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
        <button className="fab" onClick={onNewTask} aria-label="Новая задача">
          <Plus size={24} strokeWidth={2.2} />
        </button>
      )}

      {areaPop && (
        <MenuPopover
          anchor={areaPop}
          value={project?.area_id ?? null}
          items={[{ value: null, label: "Без области" }, ...areas.map((a) => ({ value: a.id, label: a.title }))]}
          onPick={(v) => { onSetArea(v as number | null); setAreaPop(null); }}
          onClose={() => setAreaPop(null)}
        />
      )}
    </main>
  );
}

function todayLabel(): string {
  return new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
}
