import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Flag, Folder, Hash, ListChecks, Moon, Plus, Repeat, Star, Trash2, X } from "lucide-react";
import { DatePickerPopover } from "./DatePicker";
import { MenuPopover } from "./Popover";
import { RepeatPopover, repeatLabel } from "./RepeatPopover";
import { projectColor } from "./colors";
import { t } from "./i18n";
import type { Project, Task } from "./types";

const isoToday = () => new Date().toISOString().slice(0, 10);
const fmt = (iso: string) => { const [, m, d] = iso.split("-"); return `${d}.${m}`; };

type Editor = "when" | "deadline" | "project" | "tags" | "checklist" | null;

interface Ops {
  patch: (id: number, body: Record<string, unknown>) => void;
  remove: (id: number, title: string) => void;
  checkAdd: (taskId: number, title: string) => void;
  checkToggle: (taskId: number, itemId: number, done: boolean) => void;
  checkRemove: (taskId: number, itemId: number) => void;
  beginEdit: (id: number) => void;
  endEdit: () => void;
}

export default function TaskDetail({
  task,
  projects,
  ops,
}: {
  task: Task;
  projects: Project[];
  ops: Ops;
}) {
  const [notes, setNotes] = useState(task.notes);
  const [tagInput, setTagInput] = useState("");
  const [checkInput, setCheckInput] = useState("");
  const [editor, setEditor] = useState<Editor>(null);
  // Floating date popover (when/deadline), anchored to its trigger.
  const [datePop, setDatePop] = useState<{ kind: "when" | "deadline"; anchor: DOMRect } | null>(null);
  const [projPop, setProjPop] = useState<DOMRect | null>(null);
  const [repPop, setRepPop] = useState<DOMRect | null>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setNotes(task.notes), [task.notes]);
  // Collapse can unmount the panel with focus still inside it (no blur fires) —
  // flush unsaved notes and release the edit guard so live-sync doesn't stay suppressed.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    if (notes !== task.notes) ops.patch(task.id, { notes });
  };
  useEffect(() => () => { flushRef.current(); ops.endEdit(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const grow = () => { const el = notesRef.current; if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; } };
  // Layout effect (not effect) so the textarea reaches full height BEFORE the parent
  // TaskRow measures the panel for its open/close animation — otherwise it measures the
  // collapsed rows=1 height and the textarea expands a frame later, causing a judder.
  useLayoutEffect(grow, [notes, editor]);

  const onBlurCapture = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) ops.endEdit();
  };
  const toggle = (e: Editor) => setEditor((c) => (c === e ? null : e));
  const openDate = (ev: React.MouseEvent, kind: "when" | "deadline") => {
    setEditor(null); setProjPop(null); setRepPop(null);
    const anchor = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    setDatePop((c) => (c?.kind === kind ? null : { kind, anchor }));
  };
  const openProj = (ev: React.MouseEvent) => {
    setEditor(null); setDatePop(null); setRepPop(null);
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    setProjPop((c) => (c ? null : rect));
  };
  const openRep = (ev: React.MouseEvent) => {
    setEditor(null); setDatePop(null); setProjPop(null);
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    setRepPop((c) => (c ? null : rect));
  };

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/^#/, "");
    if (!t || task.tags.includes(t)) return;
    ops.patch(task.id, { tags: [...task.tags, t] });
    setTagInput("");
  };
  const removeTag = (tag: string) => ops.patch(task.id, { tags: task.tags.filter((x) => x !== tag) });

  const checklist = task.checklist ?? [];
  const cdone = checklist.filter((c) => c.done).length;
  const pct = checklist.length ? Math.round((cdone / checklist.length) * 100) : 0;

  const proj = task.project_id != null ? projects.find((p) => p.id === task.project_id) : null;
  const isTodayWhen = task.when_date === isoToday();
  const scheduled = task.someday || !!task.when_date;
  const whenLabel = task.someday ? t("someday_short") : isTodayWhen ? t("view_today") : task.when_date ? fmt(task.when_date) : t("when");

  return (
    <div className="detail-inline" onFocusCapture={() => ops.beginEdit(task.id)} onBlurCapture={onBlurCapture}>
      <textarea
        ref={notesRef}
        className="d-notes-plain"
        placeholder={t("notes")}
        value={notes}
        rows={1}
        onChange={(e) => setNotes(e.target.value)}
        onInput={grow}
        onBlur={() => notes !== task.notes && ops.patch(task.id, { notes })}
      />

      {checklist.length > 0 && (
        <div>
          <div className="d-progress"><span style={{ width: pct + "%" }} /></div>
          <ul className="d-check">
            {checklist.map((c) => (
              <li key={c.id} className={c.done ? "done" : ""} onClick={() => ops.checkToggle(task.id, c.id, !c.done)}>
                <span className="cbox">{c.done && <Check size={11} strokeWidth={3.4} />}</span>
                <span className="ct">{c.title}</span>
                <button className="cdel" onClick={(e) => { e.stopPropagation(); ops.checkRemove(task.id, c.id); }} aria-label={t("delete")}>
                  <X size={13} strokeWidth={2} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {editor === "checklist" && (
        <form className="d-check-add" onSubmit={(e) => { e.preventDefault(); ops.checkAdd(task.id, checkInput); setCheckInput(""); }}>
          <Plus size={14} strokeWidth={2} />
          <input autoFocus placeholder={t("checklist_item")} value={checkInput} onChange={(e) => setCheckInput(e.target.value)} />
        </form>
      )}

      {(proj || task.deadline || task.repeat || task.tags.length > 0) && (
        <div className="d-chiprow">
          {proj && (
            <button className="vchip" onClick={openProj}>
              <span className="pdot" style={{ background: projectColor(proj.id) }} />{proj.title}
            </button>
          )}
          {task.deadline && (
            <button className="vchip dl" onClick={(e) => openDate(e, "deadline")}><Flag size={12} strokeWidth={2} />{fmt(task.deadline)}</button>
          )}
          {task.repeat && (
            <button className="vchip" onClick={openRep}><Repeat size={12} strokeWidth={2} />{repeatLabel(task.repeat)}</button>
          )}
          {task.tags.map((tag) => (
            <button className="vchip tagc" key={tag} onClick={() => toggle("tags")}>{tag}</button>
          ))}
        </div>
      )}

      {editor === "tags" && (
        <div className="d-editor">
          {task.tags.map((tag) => (
            <span className="chip tag editable" key={tag}>{tag}<button onClick={() => removeTag(tag)} aria-label={t("remove_tag")}><X size={11} strokeWidth={2.5} /></button></span>
          ))}
          <input
            autoFocus
            className="tag-input"
            placeholder={t("tag_placeholder")}
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); addTag(tagInput); }
              if (e.key === "Backspace" && !tagInput && task.tags.length) removeTag(task.tags[task.tags.length - 1]);
            }}
            onBlur={() => addTag(tagInput)}
          />
        </div>
      )}

      <div className="d-bar">
        <button className={"when-pill" + (scheduled ? " on" : "")} onClick={(e) => openDate(e, "when")}>
          <Star size={14} strokeWidth={2} fill={isTodayWhen ? "currentColor" : "none"} />
          {whenLabel}
        </button>
        <div className="d-tools">
          <button className={"d-tool" + (task.tags.length ? " on" : "")} onClick={() => toggle("tags")} aria-label={t("tags")}><Hash size={16} strokeWidth={2} /></button>
          <button className={"d-tool" + (editor === "checklist" || checklist.length ? " on" : "")} onClick={() => toggle("checklist")} aria-label={t("checklist")}><ListChecks size={16} strokeWidth={2} /></button>
          <button className={"d-tool" + (task.deadline ? " on" : "")} onClick={(e) => openDate(e, "deadline")} aria-label={t("deadline")}><Flag size={16} strokeWidth={2} /></button>
          <button className={"d-tool" + (task.repeat ? " on" : "")} onClick={openRep} aria-label={t("repeat")}><Repeat size={16} strokeWidth={2} /></button>
          <button className={"d-tool" + (proj ? " on" : "")} onClick={openProj} aria-label={t("project")}><Folder size={16} strokeWidth={2} /></button>
          <button className="d-tool del" onClick={() => ops.remove(task.id, task.title)} aria-label={t("delete")}><Trash2 size={16} strokeWidth={2} /></button>
        </div>
      </div>

      {(task.moves ?? 0) > 0 && (
        <div className="d-hist">
          {t("postponed")}: {task.moves}{task.created_at && ` · ${t("created")} ${fmt(task.created_at)}`}
        </div>
      )}

      {datePop?.kind === "when" && (
        <DatePickerPopover
          anchor={datePop.anchor}
          value={task.when_date ?? null}
          quick={[
            { key: "today", label: t("view_today"), icon: <Star size={13} strokeWidth={2} />, onClick: () => { ops.patch(task.id, { when: "today" }); setDatePop(null); } },
            { key: "someday", label: t("someday_short"), icon: <Moon size={13} strokeWidth={2} />, onClick: () => { ops.patch(task.id, { when: "someday" }); setDatePop(null); } },
            ...(scheduled ? [{ key: "clear", label: t("remove"), danger: true, onClick: () => { ops.patch(task.id, { when: "" }); setDatePop(null); } }] : []),
          ]}
          onPick={(d) => { ops.patch(task.id, { when: d }); setDatePop(null); }}
          onClose={() => setDatePop(null)}
        />
      )}
      {datePop?.kind === "deadline" && (
        <DatePickerPopover
          anchor={datePop.anchor}
          value={task.deadline ?? null}
          quick={task.deadline ? [{ key: "clear", label: t("clear_deadline"), danger: true, onClick: () => { ops.patch(task.id, { deadline: "" }); setDatePop(null); } }] : []}
          onPick={(d) => { ops.patch(task.id, { deadline: d }); setDatePop(null); }}
          onClose={() => setDatePop(null)}
        />
      )}
      {repPop && (
        <RepeatPopover
          anchor={repPop}
          value={task.repeat ?? null}
          onSave={(r) => { ops.patch(task.id, { repeat: r }); setRepPop(null); }}
          onClear={() => { ops.patch(task.id, { repeat: {} }); setRepPop(null); }}
          onClose={() => setRepPop(null)}
        />
      )}
      {projPop && (
        <MenuPopover
          anchor={projPop}
          value={task.project_id ?? null}
          items={[
            { value: null, label: t("no_project") },
            ...projects.map((p) => ({ value: p.id, label: p.title, dot: projectColor(p.id) })),
          ]}
          onPick={(v) => { ops.patch(task.id, { project: v === null ? "null" : v }); setProjPop(null); }}
          onClose={() => setProjPop(null)}
        />
      )}
    </div>
  );
}
