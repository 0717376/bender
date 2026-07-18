import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { CalendarDays, Check, CheckCircle2, CircleDashed, Inbox, Layers, Moon, Plus, Settings, Star, X } from "lucide-react";
import { projectColor } from "./colors";
import { t } from "./i18n";
import type { Overview } from "./types";
import type { Sel } from "./useTasks";

type IconType = typeof Inbox;

const TOP_VIEWS: { key: string; label: string; Icon: IconType }[] = [
  { key: "inbox", label: t("view_inbox"), Icon: Inbox },
  { key: "today", label: t("view_today"), Icon: Star },
  { key: "upcoming", label: t("view_upcoming"), Icon: CalendarDays },
  { key: "anytime", label: t("view_anytime"), Icon: Layers },
  { key: "someday", label: t("view_someday"), Icon: Moon },
];
const LOGBOOK = { key: "logbook", label: t("view_logbook"), Icon: CheckCircle2 };

// Views that accept a dragged task (highlight + actual move). Others are droppable but no-op.
const TARGET_VIEWS = new Set(["today", "upcoming", "anytime", "someday", "inbox"]);

export const VIEWS = [...TOP_VIEWS, LOGBOOK];
export const VIEW_ICON: Record<string, IconType> = Object.fromEntries(VIEWS.map((v) => [v.key, v.Icon]));

function NavView({ keyName, label, Icon, active, count, onPick }: {
  keyName: string; label: string; Icon: IconType; active: boolean; count: number; onPick: () => void;
}) {
  const target = TARGET_VIEWS.has(keyName);
  const { setNodeRef, isOver } = useDroppable({ id: `drop:view:${keyName}` });
  return (
    <button
      ref={setNodeRef}
      className={"nav" + (keyName === "inbox" ? " sep" : "") + (active ? " active" : "") + (isOver && target ? " drop-over" : "")}
      onClick={onPick}
    >
      <span className="ic"><Icon size={16} strokeWidth={1.9} /></span>
      <span className="lbl">{label}</span>
      {count > 0 && <span className="count">{count}</span>}
    </button>
  );
}

function AreaBtn({ id, title, active, onPick }: {
  id: number; title: string; active: boolean; onPick: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `drop:area:${id}` });
  return (
    <button
      ref={setNodeRef}
      className={"section section-btn" + (active ? " active" : "") + (isOver ? " drop-over" : "")}
      onClick={onPick}
    >
      {title}
    </button>
  );
}

function ProjectBtn({ id, title, active, open, total, onPick }: {
  id: number; title: string; active: boolean; open: number; total: number; onPick: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `drop:proj:${id}` });
  const color = projectColor(id);
  const r = 5, c = 2 * Math.PI * r;
  const done = Math.max(0, total - open);
  return (
    <button
      ref={setNodeRef}
      className={"nav" + (active ? " active" : "") + (isOver ? " drop-over" : "")}
      onClick={onPick}
    >
      {total > 0 ? (
        // Things-style progress pie in the project's color.
        <svg className="proj-ring" width="14" height="14" viewBox="0 0 14 14">
          <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeOpacity="0.28" strokeWidth="2.4" />
          <circle
            cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round"
            strokeDasharray={`${(done / total) * c} ${c}`} transform="rotate(-90 7 7)"
          />
        </svg>
      ) : (
        <span className="dot" style={{ background: color }} />
      )}
      <span className="lbl">{title}</span>
      {open > 0 && <span className="count">{open}</span>}
    </button>
  );
}

export default function Sidebar({
  ov,
  view,
  setView,
  onCreateProject,
  onCreateArea,
  onClose,
  onSettings,
  dragging,
}: {
  ov: Overview | null;
  view: Sel;
  setView: (s: Sel) => void;
  onCreateProject: (title: string) => void;
  onCreateArea: (title: string) => void;
  onClose?: () => void;
  onSettings: () => void;
  dragging?: boolean;
}) {
  const [adding, setAdding] = useState<"choose" | "project" | "area" | null>(null);
  const [name, setName] = useState("");
  const projects = ov?.projects ?? [];
  const areas = ov?.areas ?? [];
  const progress = ov?.progress ?? {};
  const pick = (s: Sel) => { setView(s); onClose?.(); };

  const navView = (key: string, label: string, Icon: IconType) => (
    <NavView
      key={key}
      keyName={key}
      label={label}
      Icon={Icon}
      active={view.kind === "view" && view.key === key}
      count={ov ? ov.counts[key] ?? 0 : 0}
      onPick={() => pick({ kind: "view", key, label })}
    />
  );

  const projBtn = (p: { id: number; title: string }) => (
    <ProjectBtn
      key={p.id}
      id={p.id}
      title={p.title}
      active={view.kind === "project" && view.id === p.id}
      open={progress[p.id]?.open ?? 0}
      total={progress[p.id]?.total ?? 0}
      onPick={() => pick({ kind: "project", key: "p", id: p.id, label: p.title })}
    />
  );

  const ungrouped = projects.filter((p) => p.area_id == null);

  return (
    <aside className={"sidebar scroll" + (dragging ? " dragging" : "")}>
      <div className="brand">
        <span className="logo"><Check size={16} strokeWidth={3} /></span>
        <span className="word">{t("app_title")}</span>
        {onClose && <button className="side-x" onClick={onClose} aria-label={t("close_menu")}><X size={16} /></button>}
      </div>

      {TOP_VIEWS.map((v) => navView(v.key, v.label, v.Icon))}

      <div className="side-divider" />

      {areas.map((a) => {
        const inArea = projects.filter((p) => p.area_id === a.id);
        return (
          <div key={a.id}>
            <AreaBtn
              id={a.id}
              title={a.title}
              active={view.kind === "area" && view.id === a.id}
              onPick={() => pick({ kind: "area", key: "a", id: a.id, label: a.title })}
            />
            {inArea.map(projBtn)}
          </div>
        );
      })}

      {ungrouped.length > 0 && <div className="section">{t("projects")}</div>}
      {ungrouped.map(projBtn)}

      {adding === "project" || adding === "area" ? (
        <form
          className="proj-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) (adding === "area" ? onCreateArea : onCreateProject)(name.trim());
            setName("");
            setAdding(null);
          }}
        >
          <input
            autoFocus
            placeholder={adding === "area" ? t("area_name") : t("project_name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (!name.trim()) setAdding(null); }}
            onKeyDown={(e) => e.key === "Escape" && setAdding(null)}
          />
        </form>
      ) : adding === "choose" ? (
        <div className="newlist" onMouseLeave={() => setAdding(null)}>
          <button className="newlist-opt" onClick={() => setAdding("project")}>
            <span className="ic"><CircleDashed size={16} strokeWidth={1.9} /></span>
            <span>
              <span className="nl-name">{t("new_project")}</span>
              <span className="nl-hint">{t("new_project_hint")}</span>
            </span>
          </button>
          <button className="newlist-opt" onClick={() => setAdding("area")}>
            <span className="ic"><Layers size={16} strokeWidth={1.9} /></span>
            <span>
              <span className="nl-name">{t("new_area")}</span>
              <span className="nl-hint">{t("new_area_hint")}</span>
            </span>
          </button>
        </div>
      ) : (
        <button className="nav muted" onClick={() => setAdding("choose")}>
          <span className="ic"><Plus size={16} strokeWidth={1.9} /></span>
          <span className="lbl">{t("new_list")}</span>
        </button>
      )}

      <div className="spacer" />
      <div className="side-foot">
        {navView(LOGBOOK.key, LOGBOOK.label, LOGBOOK.Icon)}
        <button className="foot-gear" onClick={onSettings} aria-label={t("settings")}>
          <Settings size={16} strokeWidth={1.9} />
        </button>
      </div>
    </aside>
  );
}
