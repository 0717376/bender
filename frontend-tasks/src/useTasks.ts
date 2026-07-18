import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribeTasks } from "./api";
import { t } from "./i18n";
import type { Overview, Task } from "./types";

// view = built-in list, project/area = one container, tag = all open tasks carrying a tag (key = tag name)
export type Sel = { kind: "view" | "project" | "area" | "tag"; key: string; id?: number; label: string };

const VIEW_LABELS: Record<string, string> = {
  today: t("view_today"), inbox: t("view_inbox"), upcoming: t("view_upcoming"),
  anytime: t("view_anytime"), someday: t("view_someday"), logbook: t("view_logbook"),
};

// Selection ⇄ URL hash (#today, #project/5, #tag/дом): refresh restores the list, back/forward navigate.
const hashOf = (v: Sel) =>
  v.kind === "project" ? `#project/${v.id}`
  : v.kind === "area" ? `#area/${v.id}`
  : v.kind === "tag" ? `#tag/${encodeURIComponent(v.key)}` : `#${v.key}`;

function parseHash(): Sel | null {
  let h: string;
  try { h = decodeURIComponent(location.hash.slice(1)); } catch { return null; }
  if (h.startsWith("project/")) {
    const id = Number(h.slice(8));
    // label resolves from the overview once it loads
    return Number.isFinite(id) ? { kind: "project", key: "p", id, label: "" } : null;
  }
  if (h.startsWith("area/")) {
    const id = Number(h.slice(5));
    return Number.isFinite(id) ? { kind: "area", key: "a", id, label: "" } : null;
  }
  if (h.startsWith("tag/")) {
    const t = h.slice(4);
    return t ? { kind: "tag", key: t, label: `#${t}` } : null;
  }
  return VIEW_LABELS[h] ? { kind: "view", key: h, label: VIEW_LABELS[h] } : null;
}

const sameSel = (a: Sel, b: Sel) => a.kind === b.kind && a.key === b.key && a.id === b.id;

export interface ToastMsg {
  id: string;
  text: string;
  undo?: () => void;
}

const COMPLETE_ANIM_MS = 280;

const isoToday = () => new Date().toISOString().slice(0, 10);

export const isOverdue = (t: Task, today: string): boolean =>
  !!((t.when_date && t.when_date < today) || (t.deadline && t.deadline < today));

// Today renders Overdue above Today — keep the array in that visual order so dnd indexes match the screen.
const todayOrder = (list: Task[]): Task[] => {
  const today = isoToday();
  const over = list.filter((t) => isOverdue(t, today));
  return over.length ? [...over, ...list.filter((t) => !isOverdue(t, today))] : list;
};

export function useTasks(pushToast: (t: ToastMsg) => void) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [view, setView] = useState<Sel>(() => parseHash() ?? { kind: "view", key: "today", label: t("view_today") });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [doneTasks, setDoneTasks] = useState<Task[]>([]); // "Done today" (Today) / "Logbook" (project)
  const [completing, setCompleting] = useState<Set<number>>(new Set());
  const [entering, setEntering] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);

  const viewRef = useRef(view);
  viewRef.current = view;
  const loadSeq = useRef(0);

  // Live-sync guards: never clobber an open inline editor or an in-flight drag.
  const fieldFocused = useRef(false);
  const dragging = useRef(false);
  const pendingReload = useRef(false);
  const editingId = useRef<number | null>(null);

  const loadOverview = useCallback(() => api.overview().then(setOverview).catch(() => {}), []);

  const loadTasks = useCallback(async () => {
    const v = viewRef.current;
    try {
      let fresh =
        v.kind === "view" ? await api.list(v.key)
        : v.kind === "tag" ? await api.list("", undefined, v.key)
        : v.kind === "area" ? await api.list("", undefined, undefined, v.id)
        : await api.list("", v.id);
      if (v.kind === "view" && v.key === "today") fresh = todayOrder(fresh);
      if (v.kind === "view" && v.key === "today") {
        api.list("done_today").then(setDoneTasks).catch(() => setDoneTasks([]));
      } else if (v.kind === "project") {
        api.list("logbook", v.id).then(setDoneTasks).catch(() => setDoneTasks([]));
      } else {
        setDoneTasks([]);
      }
      setTasks((prev) => {
        // Preserve the row being actively edited so a background refresh can't reset its inputs.
        const keepId = fieldFocused.current ? editingId.current : null;
        if (keepId == null) return fresh;
        const local = prev.find((t) => t.id === keepId);
        return local ? fresh.map((t) => (t.id === keepId ? local : t)) : fresh;
      });
    } catch {
      setTasks([]);
    }
  }, []);

  const reload = useCallback(async () => {
    await Promise.all([loadOverview(), loadTasks()]);
  }, [loadOverview, loadTasks]);

  useEffect(() => void loadOverview(), [loadOverview]);

  // --- URL hash sync ---
  useEffect(() => {
    const h = hashOf(view);
    if (location.hash !== h) history.pushState(null, "", h);
  }, [view]);
  useEffect(() => {
    const onPop = () => {
      const v = parseHash();
      if (v && !sameSel(v, viewRef.current)) setView(v);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // A project/area restored from the hash has no title yet — resolve it from the overview
  // (or bounce to Today if it no longer exists).
  useEffect(() => {
    const v = viewRef.current;
    if (!overview || (v.kind !== "project" && v.kind !== "area") || v.label) return;
    const c = v.kind === "project"
      ? overview.projects.find((x) => x.id === v.id)
      : overview.areas.find((x) => x.id === v.id);
    setView(c ? { ...v, label: c.title } : { kind: "view", key: "today", label: t("view_today") });
  }, [overview]);

  // On view switch: clear immediately so the previous view's rows never flash, then load.
  // Keyed by selection identity, not object identity — a label backfill must not reload.
  const selKey = `${view.kind}:${view.key}:${view.id ?? ""}`;
  useEffect(() => {
    const seq = ++loadSeq.current;
    setTasks([]);
    setLoading(true);
    (async () => {
      await loadTasks();
      if (seq === loadSeq.current) setLoading(false);
    })();
  }, [selKey, loadTasks]);

  // SSE: refresh when the agent (chat/Telegram/cron) or another tab mutates data.
  useEffect(() => {
    const onChange = () => {
      if (fieldFocused.current || dragging.current) {
        pendingReload.current = true;
        loadOverview(); // sidebar counts are always safe to refresh
        return;
      }
      void reload();
    };
    return subscribeTasks(onChange);
  }, [reload, loadOverview]);

  // --- interaction guards (called by the inline detail / dnd) ---
  const beginEdit = useCallback((id: number) => {
    editingId.current = id;
    fieldFocused.current = true;
  }, []);
  const endEdit = useCallback(() => {
    fieldFocused.current = false;
    if (pendingReload.current) {
      pendingReload.current = false;
      void reload();
    }
  }, [reload]);
  const setDragging = useCallback((v: boolean) => {
    dragging.current = v;
    if (!v && pendingReload.current) {
      pendingReload.current = false;
      void reload();
    }
  }, [reload]);

  // --- mutations (optimistic) ---

  const add = useCallback(
    async (title: string, extra?: Record<string, unknown>) => {
      const t = title.trim();
      if (!t) return;
      const v = viewRef.current;
      // The new-task modal passes explicit fields; bare calls fall back to view defaults.
      const body = extra ?? {
        when: v.kind === "view" && ["today", "someday", "anytime"].includes(v.key) ? v.key : undefined,
        project: v.kind === "project" ? v.id : undefined,
        area_id: v.kind === "area" ? v.id : undefined,
      };
      const created = await api.create({ title: t, ...body });
      await reload();
      if (created?.id != null) {
        setEntering((s) => new Set(s).add(created.id));
        setTimeout(() => setEntering((s) => {
          const n = new Set(s);
          n.delete(created.id);
          return n;
        }), 360);
      }
    },
    [reload],
  );

  const leavesView = (willComplete: boolean) => {
    const v = viewRef.current;
    return v.key === "logbook" ? !willComplete : willComplete;
  };

  const toggle = useCallback(
    (task: Task) => {
      const willComplete = task.status !== "completed";
      // Optimistically flip; if it drops out of the current view, animate then remove.
      if (leavesView(willComplete)) {
        setCompleting((s) => new Set(s).add(task.id));
        setTimeout(() => {
          setTasks((prev) => prev.filter((x) => x.id !== task.id));
          // Land the crossed-out task in the view's done block (Done today / Logbook) right away.
          const v = viewRef.current;
          if (willComplete && ((v.kind === "view" && v.key === "today") || v.kind === "project")) {
            const iso = new Date().toISOString().slice(0, 10);
            setDoneTasks((prev) => [{ ...task, status: "completed", completed_at: iso }, ...prev]);
          }
          setCompleting((s) => {
            const n = new Set(s);
            n.delete(task.id);
            return n;
          });
          loadOverview();
        }, COMPLETE_ANIM_MS);
      } else {
        setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, status: willComplete ? "completed" : "open" } : x)));
      }
      if (!willComplete) setDoneTasks((prev) => prev.filter((x) => x.id !== task.id));
      api.complete(task.id, willComplete).catch(() => reload());
      if (willComplete) {
        pushToast({
          id: `c${task.id}-${Date.now()}`,
          text: `${t("toast_done")}: ${task.title}`,
          undo: () => {
            api.complete(task.id, false).then(reload).catch(() => {});
          },
        });
      }
    },
    [loadOverview, reload, pushToast],
  );

  const patch = useCallback(
    async (id: number, body: Record<string, unknown>) => {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...body } : t)));
      try {
        const server = await api.patch(id, body);
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...server } : t)));
        loadOverview();
        // when/project reconcile even mid-edit — the row must leave the view right away
        const affectsMembership = "when" in body || "project" in body;
        if (affectsMembership || !fieldFocused.current) void loadTasks();
      } catch {
        void reload();
      }
      return id;
    },
    [loadOverview, loadTasks, reload],
  );

  const remove = useCallback(
    (id: number, title: string) => {
      setTasks((prev) => prev.filter((t) => t.id !== id));
      api.remove(id).then(loadOverview).catch(() => reload());
      pushToast({
        id: `d${id}-${Date.now()}`,
        text: `${t("toast_deleted")}: ${title}`,
        undo: () => { api.restore(id).then(reload).catch(() => {}); },
      });
    },
    [loadOverview, reload, pushToast],
  );

  const reorder = useCallback((ordered: Task[]) => {
    setTasks(ordered);
    api.reorder(ordered.map((t) => t.id)).catch(() => {});
  }, []);

  /** Local-only reorder for live drag previews — nothing is persisted. */
  const arrange = useCallback((ordered: Task[]) => setTasks(ordered), []);

  // --- checklist (optimistic on the open task) ---
  const patchLocal = (id: number, fn: (t: Task) => Task) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));

  const checkAdd = useCallback(async (taskId: number, title: string) => {
    const t = title.trim();
    if (!t) return;
    const { id } = await api.checkAdd(taskId, t);
    patchLocal(taskId, (task) => ({
      ...task,
      checklist: [...(task.checklist ?? []), { id, title: t, done: false, sort: 0 }],
      checklist_total: (task.checklist_total ?? 0) + 1,
    }));
  }, []);

  const checkToggle = useCallback((taskId: number, itemId: number, done: boolean) => {
    patchLocal(taskId, (task) => ({
      ...task,
      checklist: (task.checklist ?? []).map((c) => (c.id === itemId ? { ...c, done } : c)),
      checklist_done: (task.checklist_done ?? 0) + (done ? 1 : -1),
    }));
    api.checkToggle(itemId, done).catch(() => {});
  }, []);

  const checkRemove = useCallback((taskId: number, itemId: number) => {
    patchLocal(taskId, (task) => {
      const item = (task.checklist ?? []).find((c) => c.id === itemId);
      return {
        ...task,
        checklist: (task.checklist ?? []).filter((c) => c.id !== itemId),
        checklist_total: Math.max(0, (task.checklist_total ?? 0) - 1),
        checklist_done: (task.checklist_done ?? 0) - (item?.done ? 1 : 0),
      };
    });
    api.checkRemove(itemId).catch(() => {});
  }, []);

  /** Lazy-load the full checklist when a row is expanded. */
  const hydrate = useCallback(async (id: number) => {
    try {
      const full = await api.get(id);
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...full } : t)));
    } catch {
      /* ignore */
    }
  }, []);

  return {
    overview, view, setView, tasks, doneTasks, completing, entering, loading,
    reload, add, toggle, patch, remove, reorder, arrange, hydrate,
    checkAdd, checkToggle, checkRemove,
    beginEdit, endEdit, setDragging,
  };
}
