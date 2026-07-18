import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, Search, Sparkles } from "lucide-react";
import {
  DndContext, DragEndEvent, DragOverEvent, DragStartEvent, DragOverlay,
  KeyboardSensor, MouseSensor, TouchSensor, pointerWithin, closestCenter, useSensor, useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { CollisionDetection } from "@dnd-kit/core";
import { api, getToken, login } from "./api";
import ChatPane from "./ChatPane";
import CommandPalette from "./CommandPalette";
import ConfirmModal from "./ConfirmModal";
import NewTaskModal from "./NewTaskModal";
import SettingsModal, { ThemeMode } from "./SettingsModal";
import Sidebar from "./Sidebar";
import TaskList from "./TaskList";
import { DragCard } from "./TaskRow";
import Toasts from "./Toast";
import { t, t as tr } from "./i18n"; // tr: alias for scopes where a local `t` shadows the import
import type { Task } from "./types";
import { Sel, ToastMsg, isOverdue, useTasks } from "./useTasks";


const pad = (n: number) => String(n).padStart(2, "0");
const tomorrowISO = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** What dropping a task onto a sidebar target does. null = not a move target (no-op). */
function dropBody(overId: string): Record<string, unknown> | null {
  if (overId === "drop:view:today") return { when: "today" };
  if (overId === "drop:view:upcoming") return { when: tomorrowISO() }; // nearest future day
  if (overId === "drop:view:anytime") return { when: "anytime" };
  if (overId === "drop:view:someday") return { when: "someday" };
  if (overId === "drop:view:inbox") return { project: "null", when: "inbox" };
  if (overId.startsWith("drop:proj:")) return { project: Number(overId.slice(10)) };
  if (overId.startsWith("drop:area:")) return { area_id: Number(overId.slice(10)), project: "null" };
  return null;
}

const isoToday = () => new Date().toISOString().slice(0, 10);

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  if (!authed) return <Auth onOk={() => setAuthed(true)} />;
  return <Board />;
}

function Auth({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(pw);
      onOk();
    } catch {
      setErr(t("wrong_password"));
    }
  };
  return (
    <div className="auth">
      <form onSubmit={submit}>
        <h1>{t("app_title")}</h1>
        <input type="password" placeholder={t("password")} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {err && <div className="err">{err}</div>}
        <button type="submit">{t("sign_in")}</button>
      </form>
    </div>
  );
}

function taskToView(t: Task, projLabel: (id: number) => string, areaLabel: (id: number) => string): Sel {
  if (t.status === "completed") return { kind: "view", key: "logbook", label: tr("view_logbook") };
  if (t.someday) return { kind: "view", key: "someday", label: tr("view_someday") };
  if (t.project_id != null) return { kind: "project", key: "p", id: t.project_id, label: projLabel(t.project_id) };
  if (t.when_date && t.when_date <= isoToday()) return { kind: "view", key: "today", label: tr("view_today") };
  if (t.when_date) return { kind: "view", key: "upcoming", label: tr("view_upcoming") };
  if (t.area_id != null) return { kind: "area", key: "a", id: t.area_id, label: areaLabel(t.area_id) };
  if (t.triaged) return { kind: "view", key: "anytime", label: tr("view_anytime") };
  return { kind: "view", key: "inbox", label: tr("view_inbox") };
}

function Board() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const pushToast = useCallback((t: ToastMsg) => setToasts((p) => [...p, t]), []);
  const dismissToast = useCallback((id: string) => setToasts((p) => p.filter((t) => t.id !== id)), []);

  const T = useTasks(pushToast);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState<{ id: number; title: string; kind?: string } | null>(null);
  const [navOpen, setNavOpen] = useState(false); // mobile sidebar drawer
  const [chatCollapsed, setChatCollapsed] = useState(() => {
    const s = localStorage.getItem("tasks_chat");
    if (s === "0") return true;
    if (s === "1") return false;
    return window.innerWidth <= 860; // default: collapsed on mobile, open on desktop
  });
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const s = localStorage.getItem("tasks_theme");
    return s === "light" || s === "dark" ? s : "auto";
  });
  const [palette, setPalette] = useState(() => localStorage.getItem("tasks_palette") ?? "halo");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  // Overdue task currently carried into the Today group mid-drag (renders there as a live preview).
  const [previewTodayId, setPreviewTodayId] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null); // keyboard-focused row
  const pendingExpand = useRef<number | null>(null);

  // Mouse drags on slight movement; touch requires a long-press so list scrolling
  // on phones never turns into an accidental reorder.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const isTodayView = T.view.kind === "view" && T.view.key === "today";
  const activeTask = activeId != null ? T.tasks.find((t) => t.id === activeId) ?? null : null;

  // Pointer-based hit testing so dropping onto a sidebar category registers reliably;
  // fall back to closestCenter for list reordering when the pointer is between rows.
  // In Today, a task from the Today group ignores the Overdue group entirely: hovering it
  // yields no target at all (no gap opens, dropping there is a no-op).
  const collision = useCallback<CollisionDetection>((args) => {
    const hits = pointerWithin(args);
    if (isTodayView && activeTask && !isOverdue(activeTask, isoToday())) {
      const today = isoToday();
      const overdueIds = new Set(T.tasks.filter((t) => isOverdue(t, today)).map((t) => t.id));
      const blocked = (id: unknown) => typeof id === "number" && overdueIds.has(id);
      const best = hits.length ? hits : closestCenter(args);
      return best.length && blocked(best[0].id) ? [] : best;
    }
    return hits.length ? hits : closestCenter(args);
  }, [isTodayView, activeTask, T.tasks]);

  // A sidebar project being dragged (id "proj:N") — its target is an area header.
  const [dragProjId, setDragProjId] = useState<number | null>(null);

  const onDragStart = (e: DragStartEvent) => {
    if (typeof e.active.id === "string" && e.active.id.startsWith("proj:")) {
      setDragProjId(Number(e.active.id.slice(5)));
      return;
    }
    setActiveId(Number(e.active.id));
    T.setDragging(true);
  };
  const onDragCancel = () => {
    setActiveId(null);
    setDragProjId(null);
    T.setDragging(false);
    if (previewTodayId != null) { setPreviewTodayId(null); void T.reload(); }
  };

  // Crossing the Overdue → Today boundary mid-drag: move the row into the Today group right away
  // so it previews as a real element there (and back, if dragged up again).
  const onDragOver = (e: DragOverEvent) => {
    if (!isTodayView) return;
    const { active, over } = e;
    if (!over || typeof over.id !== "number" || active.id === over.id) return;
    const from = T.tasks.findIndex((t) => t.id === active.id);
    const to = T.tasks.findIndex((t) => t.id === over.id);
    if (from < 0 || to < 0) return;
    const today = isoToday();
    const a = T.tasks[from];
    const aOver = isOverdue(a, today) && a.id !== previewTodayId;
    const oOver = isOverdue(T.tasks[to], today);
    if (aOver === oOver) return;
    if (aOver) setPreviewTodayId(a.id);
    else if (a.id === previewTodayId) setPreviewTodayId(null);
    else return; // genuine Today task can't enter Overdue
    const next = [...T.tasks];
    next.splice(from, 1);
    const at = next.findIndex((t) => t.id === over.id);
    next.splice(from < to ? at + 1 : at, 0, a);
    T.arrange(next);
  };

  const onDragEnd = (e: DragEndEvent) => {
    if (dragProjId != null) {
      setDragProjId(null);
      const over = e.over?.id;
      if (typeof over === "string" && over.startsWith("drop:area:")) {
        api.updateProject(dragProjId, { area_id: Number(over.slice(10)) }).then(T.reload).catch(() => {});
      } else if (over === "drop:noarea") {
        api.updateProject(dragProjId, { area_id: -1 }).then(T.reload).catch(() => {});
      }
      return;
    }
    setActiveId(null);
    T.setDragging(false);
    const preview = previewTodayId;
    setPreviewTodayId(null);
    const { active, over } = e;
    if (!over) { if (preview != null) void T.reload(); return; }
    const taskId = Number(active.id);
    if (typeof over.id === "string" && over.id.startsWith("drop:")) {
      const body = dropBody(over.id);
      if (body) T.patch(taskId, body); // membership reconciles via the patch reload
      return;
    }
    const from = T.tasks.findIndex((t) => t.id === active.id);
    const to = T.tasks.findIndex((t) => t.id === over.id);
    if (from < 0 || to < 0) { if (preview != null) void T.reload(); return; }
    let next = T.tasks;
    if (from !== to) {
      next = [...T.tasks];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
    }
    if (isTodayView) {
      if (preview === taskId) {
        // Overdue task dropped inside Today: persist the order and reschedule it
        T.reorder(next);
        T.patch(taskId, { when: "today" });
        return;
      }
      const today = isoToday();
      if (isOverdue(T.tasks[from], today) !== isOverdue(T.tasks[to], today)) return;
    }
    if (from !== to) T.reorder(next);
  };

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = themeMode === "dark" || (themeMode === "auto" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    localStorage.setItem("tasks_theme", themeMode);
    mq.addEventListener("change", apply); // follow the OS while in auto
    return () => mq.removeEventListener("change", apply);
  }, [themeMode]);

  useEffect(() => {
    if (palette === "halo") delete document.documentElement.dataset.palette;
    else document.documentElement.dataset.palette = palette;
    localStorage.setItem("tasks_palette", palette);
  }, [palette]);

  const onExpand = useCallback((id: number | null) => {
    setExpandedId(id);
    if (id != null) void T.hydrate(id);
  }, [T]);

  // Collapse the open editor and drop keyboard focus when switching views.
  useEffect(() => { setExpandedId(null); setFocusId(null); }, [T.view]);

  // Click anywhere outside any task row collapses the open card. Clicks inside a .task
  // (the open card, or another row that handles its own open) are left alone.
  useEffect(() => {
    if (expandedId == null) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest(".task") && !el.closest(".pop")) setExpandedId(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [expandedId]);

  // After a palette jump, expand the target once its list has loaded.
  useEffect(() => {
    if (pendingExpand.current != null && T.tasks.some((t) => t.id === pendingExpand.current)) {
      onExpand(pendingExpand.current);
      pendingExpand.current = null;
    }
  }, [T.tasks, onExpand]);

  const projectLabel = useCallback(
    (id: number) => T.overview?.projects.find((p) => p.id === id)?.title ?? t("project"),
    [T.overview],
  );
  const areaLabel = useCallback(
    (id: number) => T.overview?.areas.find((a) => a.id === id)?.title ?? t("area"),
    [T.overview],
  );

  const pickFromPalette = (t: Task) => {
    setPaletteOpen(false);
    pendingExpand.current = t.id;
    T.setView(taskToView(t, projectLabel, areaLabel));
  };

  const renameView = (title: string) => {
    const v = T.view;
    if (v.id == null) return;
    const call = v.kind === "project" ? api.updateProject(v.id, { title }) : api.updateArea(v.id, title);
    call.then(() => { T.setView({ ...v, label: title }); T.reload(); }).catch(() => {});
  };

  const [confirmArea, setConfirmArea] = useState<{ id: number; title: string } | null>(null);
  const deleteArea = () => {
    if (!confirmArea) return;
    api.removeArea(confirmArea.id)
      .then(() => { T.setView({ kind: "view", key: "today", label: t("view_today") }); T.reload(); })
      .catch(() => {});
    setConfirmArea(null);
  };

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((v) => !v); }
      else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setNewTaskOpen(true);
      } else if (e.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        else if (newTaskOpen || confirmDel) { /* the modal closes itself */ }
        else if (expandedId != null) setExpandedId(null);
        else if (focusId != null) setFocusId(null);
        else if (navOpen) setNavOpen(false);
        return;
      }

      // List navigation — only when not typing and no overlay is open.
      const el = e.target as HTMLElement;
      const typing = el?.matches?.("input, textarea, select, [contenteditable]");
      if (mod || typing || paletteOpen || newTaskOpen || confirmDel) return;
      const rows = T.tasks.filter((t) => t.kind !== "heading");
      if (!rows.length) return;
      const idx = focusId != null ? rows.findIndex((t) => t.id === focusId) : -1;

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setFocusId(rows[Math.min(idx + 1, rows.length - 1)].id);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setFocusId(rows[Math.max(idx - 1, 0)].id);
      } else if (e.key === "Enter" && focusId != null && expandedId == null) {
        e.preventDefault();
        onExpand(focusId);
      } else if (e.key === " " && focusId != null && expandedId == null) {
        e.preventDefault();
        const t = rows.find((x) => x.id === focusId);
        if (t) T.toggle(t);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, expandedId, navOpen, newTaskOpen, confirmDel, focusId, T, onExpand]);

  const toggleChat = () => {
    setChatCollapsed((v) => {
      localStorage.setItem("tasks_chat", v ? "1" : "0");
      return !v;
    });
  };

  // Crossing into the mobile layout (resize or browser zoom) turns the side chat into a
  // 74dvh bottom sheet — close it instead of surprising the user with a covered list.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    const onChange = () => { if (mq.matches) setChatCollapsed(true); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const ops = {
    patch: T.patch, toggle: T.toggle,
    remove: (id: number, title: string, kind?: string) => setConfirmDel({ id, title, kind }),
    checkAdd: T.checkAdd, checkToggle: T.checkToggle, checkRemove: T.checkRemove,
    beginEdit: T.beginEdit, endEdit: T.endEdit,
  };

  return (
    <div className={"board" + (navOpen ? " nav-open" : "")}>
      <div className="topbar">
        <button className="icon-btn" onClick={() => setNavOpen(true)} aria-label={t("menu")}><Menu size={20} /></button>
        <span className="topbar-title">{T.view.label}</span>
        <button className="icon-btn" onClick={() => setPaletteOpen(true)} aria-label={t("search")}><Search size={19} /></button>
        <button className="icon-btn" onClick={toggleChat} aria-label={t("assistant")}><Sparkles size={19} /></button>
      </div>

      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}

      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragCancel={onDragCancel}
        onDragEnd={onDragEnd}
      >
        <Sidebar
          ov={T.overview}
          view={T.view}
          setView={T.setView}
          onCreateProject={async (title) => { await api.createProject(title); T.reload(); }}
          onCreateArea={async (title) => { await api.createArea(title); T.reload(); }}
          onClose={navOpen ? () => setNavOpen(false) : undefined}
          onSettings={() => setSettingsOpen(true)}
          dragging={activeId != null || dragProjId != null}
          draggingProject={dragProjId != null}
        />

        <TaskList
          view={T.view}
          tasks={T.tasks}
          doneTasks={T.doneTasks}
          completing={T.completing}
          entering={T.entering}
          loading={T.loading}
          projects={T.overview?.projects ?? []}
          areas={T.overview?.areas ?? []}
          ops={ops}
          expandedId={expandedId}
          onExpand={onExpand}
          onNewTask={() => setNewTaskOpen(true)}
          onAddHeading={(title) => void T.add(title, { project: T.view.id, kind: "heading" })}
          onRenameView={renameView}
          onDeleteArea={() => {
            if (T.view.kind === "area" && T.view.id != null) setConfirmArea({ id: T.view.id, title: T.view.label });
          }}
          onOpenProject={(id) => T.setView({ kind: "project", key: "p", id, label: projectLabel(id) })}
          progress={T.overview?.progress ?? {}}
          onTag={(tag) => T.setView({ kind: "tag", key: tag, label: `#${tag}` })}
          activeId={activeId}
          previewTodayId={previewTodayId}
          focusId={focusId}
        />

        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2,0,0,1)" }}>
          {activeTask ? <DragCard task={activeTask} projects={T.overview?.projects ?? []} areas={T.overview?.areas ?? []} />
            : dragProjId != null ? <div className="proj-drag-card">{projectLabel(dragProjId)}</div> : null}
        </DragOverlay>
      </DndContext>

      {!chatCollapsed && <div className="chat-scrim" onClick={toggleChat} />}
      <ChatPane onActivity={T.reload} collapsed={chatCollapsed} onToggle={toggleChat} />

      {newTaskOpen && (
        <NewTaskModal
          view={T.view}
          projects={T.overview?.projects ?? []}
          onCreate={(title, extra) => void T.add(title, extra)}
          onClose={() => setNewTaskOpen(false)}
        />
      )}
      {confirmDel && (
        <ConfirmModal
          question={t(confirmDel.kind === "heading" ? "confirm_delete_heading" : "confirm_delete")}
          detail={confirmDel.title}
          onConfirm={() => {
            T.remove(confirmDel.id, confirmDel.title);
            setExpandedId((c) => (c === confirmDel.id ? null : c));
            setConfirmDel(null);
          }}
          onClose={() => setConfirmDel(null)}
        />
      )}
      {confirmArea && (
        <ConfirmModal
          question={t("confirm_delete_area")}
          detail={confirmArea.title}
          onConfirm={deleteArea}
          onClose={() => setConfirmArea(null)}
        />
      )}
      {paletteOpen && <CommandPalette onPick={pickFromPalette} onClose={() => setPaletteOpen(false)} />}
      {settingsOpen && (
        <SettingsModal
          mode={themeMode}
          palette={palette}
          onMode={setThemeMode}
          onPalette={setPalette}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <Toasts toasts={toasts} dismiss={dismissToast} />
    </div>
  );
}
