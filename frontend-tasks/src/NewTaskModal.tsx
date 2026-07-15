import { useEffect, useMemo, useRef, useState } from "react";
import { Flag, Folder, Moon, Repeat, Star, WandSparkles, X } from "lucide-react";
import { DatePickerPopover } from "./DatePicker";
import { parseTitle, stripMatch } from "./nlp";
import { MenuPopover } from "./Popover";
import { RepeatPopover, repeatLabel } from "./RepeatPopover";
import { projectColor } from "./colors";
import { t } from "./i18n";
import type { Project, RepeatRule } from "./types";
import type { Sel } from "./useTasks";

const pad = (n: number) => String(n).padStart(2, "0");
const tomorrowISO = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const isoToday = () => new Date().toISOString().slice(0, 10);
const fmt = (iso: string) => { const [, m, d] = iso.split("-"); return `${d}.${m}`; };

/** Preset the schedule/project from the space the task is being created in. */
function defaults(view: Sel): { when: string | null; project: number | null } {
  if (view.kind === "project") return { when: null, project: view.id ?? null };
  switch (view.key) {
    case "today": return { when: "today", project: null };
    case "upcoming": return { when: tomorrowISO(), project: null };
    case "someday": return { when: "someday", project: null };
    case "anytime": return { when: "anytime", project: null };
    default: return { when: null, project: null }; // inbox / logbook
  }
}

export default function NewTaskModal({ view, projects, onCreate, onClose }: {
  view: Sel;
  projects: Project[];
  onCreate: (title: string, extra: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const init = defaults(view);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [when, setWhen] = useState<string | null>(init.when);
  const [deadline, setDeadline] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<number | null>(init.project);
  const [repeat, setRepeat] = useState<RepeatRule | null>(null);
  // NLP: «завтра купить хлеб» → date hint. Manual picks win; × dismisses this match.
  const [manualWhen, setManualWhen] = useState(false);
  const [manualRepeat, setManualRepeat] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const hint = useMemo(() => parseTitle(title), [title]);
  const hintActive = hint != null && hint.matched !== dismissed;

  type Pop = { kind: "when" | "deadline" | "project" | "repeat"; anchor: DOMRect } | null;
  const [pop, setPop] = useState<Pop>(null);
  const open = (kind: NonNullable<Pop>["kind"]) => (ev: React.MouseEvent) => {
    const anchor = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    setPop((c) => (c?.kind === kind ? null : { kind, anchor }));
  };

  const notesRef = useRef<HTMLTextAreaElement>(null);
  const grow = () => { const el = notesRef.current; if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; } };

  // Esc closes the modal — unless a popover is open (its own Esc handler wins).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".pop")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = () => {
    let t = title.trim();
    if (!t) return;
    let w = when, rep = repeat;
    if (hintActive) {
      const stripped = stripMatch(t, hint.matched);
      if (stripped) t = stripped;
      if (!manualWhen && hint.when) w = hint.when;
      if (!manualRepeat && hint.repeat) rep = hint.repeat;
    }
    onCreate(t, {
      notes: notes.trim() || undefined,
      when: w ?? undefined,
      deadline: deadline ?? undefined,
      project: projectId ?? undefined,
      repeat: rep ?? undefined,
    });
    onClose();
  };

  const proj = projectId != null ? projects.find((p) => p.id === projectId) : null;
  const whenLabel = when === "someday" ? t("someday_short") : when === "anytime" ? t("view_anytime") : when === "today" || when === isoToday() ? t("view_today") : when ? fmt(when) : t("when");

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="ntm" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="ntm-title"
          placeholder={t("new_task")}
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); create(); } }}
        />
        {hintActive && (
          <div className="nlp-hint">
            <WandSparkles size={12} strokeWidth={2.2} />
            <span>{hint.label}</span>
            <button onClick={() => setDismissed(hint.matched)} aria-label={t("ignore_hint")}><X size={12} strokeWidth={2.4} /></button>
          </div>
        )}
        <textarea
          ref={notesRef}
          className="ntm-notes"
          placeholder={t("notes")}
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onInput={grow}
        />

        {(proj || deadline || repeat) && (
          <div className="d-chiprow">
            {proj && (
              <button className="vchip" onClick={open("project")}>
                <span className="pdot" style={{ background: projectColor(proj.id) }} />{proj.title}
              </button>
            )}
            {deadline && (
              <button className="vchip dl" onClick={open("deadline")}><Flag size={12} strokeWidth={2} />{fmt(deadline)}</button>
            )}
            {repeat && (
              <button className="vchip" onClick={open("repeat")}><Repeat size={12} strokeWidth={2} />{repeatLabel(repeat)}</button>
            )}
          </div>
        )}

        <div className="ntm-bar">
          <button className={"when-pill" + (when ? " on" : "")} onClick={open("when")}>
            <Star size={14} strokeWidth={2} fill={when === "today" ? "currentColor" : "none"} />
            {whenLabel}
          </button>
          <div className="d-tools">
            <button className={"d-tool" + (deadline ? " on" : "")} onClick={open("deadline")} aria-label={t("deadline")}><Flag size={16} strokeWidth={2} /></button>
            <button className={"d-tool" + (proj ? " on" : "")} onClick={open("project")} aria-label={t("project")}><Folder size={16} strokeWidth={2} /></button>
            <button className={"d-tool" + (repeat ? " on" : "")} onClick={open("repeat")} aria-label={t("repeat")}><Repeat size={16} strokeWidth={2} /></button>
          </div>
          <button className="ntm-create" disabled={!title.trim()} onClick={create}>{t("create")}</button>
        </div>

        {pop?.kind === "when" && (
          <DatePickerPopover
            anchor={pop.anchor}
            value={when === "today" ? isoToday() : when === "someday" || when === "anytime" ? null : when}
            quick={[
              { key: "today", label: t("view_today"), icon: <Star size={13} strokeWidth={2} />, onClick: () => { setWhen("today"); setManualWhen(true); setPop(null); } },
              { key: "someday", label: t("someday_short"), icon: <Moon size={13} strokeWidth={2} />, onClick: () => { setWhen("someday"); setManualWhen(true); setPop(null); } },
              ...(when ? [{ key: "clear", label: t("remove"), danger: true, onClick: () => { setWhen(null); setManualWhen(true); setPop(null); } }] : []),
            ]}
            onPick={(d) => { setWhen(d); setManualWhen(true); setPop(null); }}
            onClose={() => setPop(null)}
          />
        )}
        {pop?.kind === "deadline" && (
          <DatePickerPopover
            anchor={pop.anchor}
            value={deadline}
            quick={deadline ? [{ key: "clear", label: t("clear_deadline"), danger: true, onClick: () => { setDeadline(null); setPop(null); } }] : []}
            onPick={(d) => { setDeadline(d); setPop(null); }}
            onClose={() => setPop(null)}
          />
        )}
        {pop?.kind === "project" && (
          <MenuPopover
            anchor={pop.anchor}
            value={projectId}
            items={[
              { value: null, label: t("no_project") },
              ...projects.map((p) => ({ value: p.id, label: p.title, dot: projectColor(p.id) })),
            ]}
            onPick={(v) => { setProjectId(v as number | null); setPop(null); }}
            onClose={() => setPop(null)}
          />
        )}
        {pop?.kind === "repeat" && (
          <RepeatPopover
            anchor={pop.anchor}
            value={repeat}
            onSave={(r) => { setRepeat(r); setManualRepeat(true); setPop(null); }}
            onClear={() => { setRepeat(null); setManualRepeat(true); setPop(null); }}
            onClose={() => setPop(null)}
          />
        )}
      </div>
    </div>
  );
}
