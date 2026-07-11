import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, Search, Sparkles } from "lucide-react";
import {
  DndContext, DragEndEvent, DragStartEvent, DragOverlay,
  KeyboardSensor, PointerSensor, pointerWithin, closestCenter, useSensor, useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { CollisionDetection } from "@dnd-kit/core";
import { api, getToken, login } from "./api";
import ChatPane from "./ChatPane";
import CommandPalette from "./CommandPalette";
import NewTaskModal from "./NewTaskModal";
import SettingsModal, { ThemeMode } from "./SettingsModal";
import Sidebar from "./Sidebar";
import TaskList from "./TaskList";
import { DragCard } from "./TaskRow";
import Toasts from "./Toast";
import { t, t as tr } from "./i18n"; // tr: alias for scopes where a local `t` shadows the import
import type { Task } from "./types";
import { Sel, ToastMsg, useTasks } from "./useTasks";

// Pointer-based hit testing so dropping onto a sidebar category registers reliably;
// fall back to closestCenter for list reordering when the pointer is between rows.
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCenter(args);
};

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
  if (overId === "drop:view:anytime") return { when: "" };             // clear date, keep project
  if (overId === "drop:view:someday") return { when: "someday" };
  if (overId === "drop:view:inbox") return { project: "null", when: "" };
  if (overId.startsWith("drop:proj:")) return { project: Number(overId.slice(10)) };
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

function taskToView(t: Task, label: (id: number) => string): Sel {
  if (t.status === "completed") return { kind: "view", key: "logbook", label: tr("view_logbook") };
  if (t.someday) return { kind: "view", key: "someday", label: tr("view_someday") };
  if (t.project_id != null) return { kind: "project", key: "p", id: t.project_id, label: label(t.project_id) };
  if (t.when_date && t.when_date <= isoToday()) return { kind: "view", key: "today", label: tr("view_today") };
  if (t.when_date) return { kind: "view", key: "upcoming", label: tr("view_upcoming") };
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
  const [focusId, setFocusId] = useState<number | null>(null); // keyboard-focused row
  const pendingExpand = useRef<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (e: DragStartEvent) => { setActiveId(Number(e.active.id)); T.setDragging(true); };
  const onDragCancel = () => { setActiveId(null); T.setDragging(false); };
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    T.setDragging(false);
    const { active, over } = e;
    if (!over) return;
    const taskId = Number(active.id);
    if (typeof over.id === "string" && over.id.startsWith("drop:")) {
      const body = dropBody(over.id);
      if (body) T.patch(taskId, body); // membership reconciles via the patch reload
      return;
    }
    // Same-list reorder.
    if (active.id === over.id) return;
    const from = T.tasks.findIndex((t) => t.id === active.id);
    const to = T.tasks.findIndex((t) => t.id === over.id);
    if (from < 0 || to < 0) return;
    const next = [...T.tasks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    T.reorder(next);
  };
  const activeTask = activeId != null ? T.tasks.find((t) => t.id === activeId) ?? null : null;

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

  const pickFromPalette = (t: Task) => {
    setPaletteOpen(false);
    pendingExpand.current = t.id;
    T.setView(taskToView(t, projectLabel));
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
        else if (newTaskOpen) { /* the modal closes itself */ }
        else if (expandedId != null) setExpandedId(null);
        else if (focusId != null) setFocusId(null);
        else if (navOpen) setNavOpen(false);
        return;
      }

      // List navigation — only when not typing and no overlay is open.
      const el = e.target as HTMLElement;
      const typing = el?.matches?.("input, textarea, select, [contenteditable]");
      if (mod || typing || paletteOpen || newTaskOpen) return;
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
  }, [paletteOpen, expandedId, navOpen, newTaskOpen, focusId, T, onExpand]);

  const toggleChat = () => {
    setChatCollapsed((v) => {
      localStorage.setItem("tasks_chat", v ? "1" : "0");
      return !v;
    });
  };

  const ops = {
    patch: T.patch, remove: T.remove, toggle: T.toggle,
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
          dragging={activeId != null}
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
          onSetArea={(areaId) => {
            if (T.view.kind === "project" && T.view.id != null) {
              api.updateProject(T.view.id, { area_id: areaId ?? -1 }).then(T.reload).catch(() => {});
            }
          }}
          onTag={(tag) => T.setView({ kind: "tag", key: tag, label: `#${tag}` })}
          activeId={activeId}
          focusId={focusId}
        />

        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2,0,0,1)" }}>
          {activeTask ? <DragCard task={activeTask} projects={T.overview?.projects ?? []} /> : null}
        </DragOverlay>
      </DndContext>

      <ChatPane onActivity={T.reload} collapsed={chatCollapsed} onToggle={toggleChat} />

      {newTaskOpen && (
        <NewTaskModal
          view={T.view}
          projects={T.overview?.projects ?? []}
          onCreate={(title, extra) => void T.add(title, extra)}
          onClose={() => setNewTaskOpen(false)}
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
