import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Calendar, Check, Flag, ListChecks, Repeat, X } from "lucide-react";
import TaskDetail from "./TaskDetail";
import { repeatLabel } from "./RepeatPopover";
import { projectColor } from "./colors";
import { t } from "./i18n";
import type { Project, Task } from "./types";

const isoToday = () => new Date().toISOString().slice(0, 10);
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** Collapsed-row content (title + meta). Shared by the row and the drag overlay. */
export function RowBody({ task, projects, onTag }: { task: Task; projects: Project[]; onTag?: (tag: string) => void }) {
  const overdue = task.when_date && task.when_date < isoToday();
  const checkTotal = task.checklist_total ?? 0;
  const proj = task.project_id != null ? projects.find((p) => p.id === task.project_id) : null;
  // In Today every row's when_date == today → suppress that chip; keep overdue/future.
  const showWhen = task.when_date && task.when_date !== isoToday();
  const hasMeta = proj || showWhen || task.deadline || task.repeat || checkTotal > 0 || task.tags.length > 0;
  return (
    <>
      <div className="title">{task.title}</div>
      {hasMeta && (
        <div className="meta">
          {proj && (
            <span className="chip"><span className="pdot" style={{ background: projectColor(proj.id) }} />{proj.title}</span>
          )}
          {showWhen && (
            <span className={"chip " + (overdue ? "overdue" : "due")}><Calendar size={13} strokeWidth={2} />{task.when_date}</span>
          )}
          {task.deadline && <span className="chip dl"><Flag size={12} strokeWidth={2} />{task.deadline}</span>}
          {task.repeat && <span className="chip"><Repeat size={12} strokeWidth={2} />{repeatLabel(task.repeat, true)}</span>}
          {checkTotal > 0 && (
            <span className="chip"><ListChecks size={13} strokeWidth={2} />{task.checklist_done ?? 0}/{checkTotal}</span>
          )}
          {task.tags.map((tag) => (
            <span
              className={"chip tag" + (onTag ? " clickable" : "")}
              key={tag}
              onClick={onTag ? (e) => { e.stopPropagation(); onTag(tag); } : undefined}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** Static lifted card shown under the cursor while dragging (rendered in DragOverlay). */
export function DragCard({ task, projects }: { task: Task; projects: Project[] }) {
  const done = task.status === "completed";
  return (
    <div className="task task-overlay">
      <div className="task-head">
        <span className={"check" + (done ? " done" : "")}>{done && <Check size={13} strokeWidth={3.2} />}</span>
        <div className="body"><RowBody task={task} projects={projects} /></div>
      </div>
    </div>
  );
}

interface Ops {
  patch: (id: number, body: Record<string, unknown>) => void;
  remove: (id: number, title: string, kind?: string) => void;
  toggle: (t: Task) => void;
  checkAdd: (taskId: number, title: string) => void;
  checkToggle: (taskId: number, itemId: number, done: boolean) => void;
  checkRemove: (taskId: number, itemId: number) => void;
  beginEdit: (id: number) => void;
  endEdit: () => void;
}

export default function TaskRow({
  task,
  expanded,
  completing,
  entering,
  dragging,
  draggable,
  focused,
  projects,
  ops,
  onExpand,
  onTag,
}: {
  task: Task;
  expanded: boolean;
  completing: boolean;
  entering: boolean;
  dragging: boolean;
  draggable: boolean;
  focused?: boolean;
  projects: Project[];
  ops: Ops;
  onExpand: (id: number | null) => void;
  onTag?: (tag: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: task.id,
    disabled: !draggable || expanded,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const done = task.status === "completed";

  const [title, setTitle] = useState(task.title);
  const [editingHead, setEditingHead] = useState(false);
  useEffect(() => setTitle(task.title), [task.title]);

  const liRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focused) liRef.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  const setRefs = (el: HTMLLIElement | null) => { liRef.current = el; setNodeRef(el); };

  // Height accordion: mount the detail, then animate its wrapper's pixel height.
  // 0 → scrollHeight → auto on open; scrollHeight → 0 on close (unmount at end).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [render, setRender] = useState(expanded);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (expanded && !render) setRender(true); // mount before measuring/animating
  }, [expanded, render]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName !== "height" || e.target !== el) return;
      el.removeEventListener("transitionend", onEnd);
      if (expanded) { el.style.height = "auto"; setOpening(false); }
      else setRender(false);
    };
    let raf = 0;
    if (expanded) {
      el.style.height = el.scrollHeight + "px"; // from CSS 0 → content height
      setOpening(true);
    } else {
      el.style.height = el.scrollHeight + "px"; // pin current height (was auto)
      void el.offsetHeight;                     // force reflow so the next set animates
      raf = requestAnimationFrame(() => { el.style.height = "0px"; });
    }
    el.addEventListener("transitionend", onEnd);
    return () => { el.removeEventListener("transitionend", onEnd); cancelAnimationFrame(raf); };
  }, [expanded, render]);

  // Section heading inside a project: no checkbox, no detail — just a divider with inline rename.
  if (task.kind === "heading") {
    return (
      <li ref={setRefs} style={style} className={"task h-row" + (dragging ? " placeholder" : "")}>
        <div className="h-inner" {...attributes} {...listeners}>
          {editingHead ? (
            <input
              className="h-input"
              value={title}
              autoFocus
              onPointerDown={stop}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => { setEditingHead(false); if (title.trim() && title !== task.title) ops.patch(task.id, { title: title.trim() }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") { setTitle(task.title); setEditingHead(false); }
              }}
            />
          ) : (
            <span className="h-title" onClick={() => setEditingHead(true)}>{task.title}</span>
          )}
          <button className="h-del" onPointerDown={stop} onClick={(e) => { stop(e); ops.remove(task.id, task.title, "heading"); }} aria-label={t("delete_heading")}>
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      </li>
    );
  }

  return (
    <li
      ref={setRefs}
      style={style}
      className={
        "task" +
        (expanded || render ? " expanded" : "") +
        (done ? " completed" : "") +
        (completing ? " completing" : "") +
        (entering ? " entering" : "") +
        (dragging ? " placeholder" : "") +
        (focused ? " kbd" : "")
      }
    >
      <div className="task-head" {...attributes} {...listeners} onClick={() => onExpand(expanded ? null : task.id)}>
        <button
          className={"check" + (done ? " done" : "")}
          onPointerDown={stop}
          onClick={(e) => { stop(e); ops.toggle(task); }}
          aria-label={done ? t("mark_open") : t("mark_done")}
        >
          {done && <Check size={13} strokeWidth={3.2} />}
        </button>

        {expanded ? (
          <input
            className="d-title"
            value={title}
            placeholder={t("untitled")}
            onPointerDown={stop}
            onClick={stop}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={() => ops.beginEdit(task.id)}
            onBlur={() => { ops.endEdit(); if (title !== task.title) ops.patch(task.id, { title }); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") onExpand(null);
            }}
          />
        ) : (
          <div className="body"><RowBody task={task} projects={projects} onTag={onTag} /></div>
        )}
      </div>

      {render && (
        <div ref={wrapRef} className={"detail-wrap" + (opening ? " opening" : "")}>
          <TaskDetail task={task} projects={projects} ops={ops} />
        </div>
      )}
    </li>
  );
}
