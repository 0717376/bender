import { useEffect, useRef, useState } from "react";
import { Pause, Play, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "./api";
import { numbers, wrap } from "./cloze";
import { dueIn } from "./fmt";
import { t } from "./i18n";
import { LEARNING, NEW, RELEARNING } from "./types";
import type { CardState, Deck, Fields, Kind, Note } from "./types";

const KINDS: Kind[] = ["word", "basic", "cloze"];

const WORD: { key: string; label: string; wide?: boolean; area?: boolean }[] = [
  { key: "word", label: "f_word" }, { key: "meaning", label: "f_meaning" },
  { key: "ipa", label: "f_ipa" }, { key: "pos", label: "f_pos" },
  { key: "lemma", label: "f_lemma" }, { key: "other", label: "f_other" },
  { key: "example", label: "f_example", wide: true, area: true },
  { key: "example_tr", label: "f_example_tr", wide: true, area: true },
];

const tplName = (kind: Kind, tpl: string) =>
  kind === "cloze" ? t("tpl_cloze", tpl.slice(1)) : tpl === "rev" ? (kind === "word" ? t("tpl_recall") : t("tpl_reverse")) : (kind === "word" ? t("tpl_recognize") : t("tpl_forward"));

function stateLabel(c: CardState): string {
  if (c.suspended) return c.leech ? t("st_leech") : t("st_suspended");
  if (c.state === NEW) return t("st_new");
  if (c.state === LEARNING || c.state === RELEARNING) return t("st_learning");
  return c.due != null && c.due <= Date.now() ? t("st_due") : t("st_due_in", dueIn(c.due));
}

/** Создание и правка заметки. Правка полей не трогает выученное: карточки остаются те же. */
export default function NoteEditor({ note, decks, deckId, onClose, onSaved, notify }: {
  note: Note | null; decks: Deck[]; deckId?: number;
  onClose: () => void; onSaved: () => void; notify: (text: string) => void;
}) {
  const [kind, setKind] = useState<Kind>(note?.kind ?? "word");
  const [fields, setFields] = useState<Fields>(note?.fields ?? {});
  const [deck, setDeck] = useState<string>(String(note?.deck_id ?? deckId ?? ""));
  const [cards, setCards] = useState<CardState[]>(note?.cards ?? []);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const clozeRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const val = (k: string) => (typeof fields[k] === "string" ? (fields[k] as string) : "");
  const set = (k: string, v: string | boolean) => setFields((f) => ({ ...f, [k]: v }));

  const hide = () => {
    const el = clozeRef.current;
    if (!el) return;
    set("text", wrap(val("text"), el.selectionStart, el.selectionEnd));
    el.focus();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    // Пустые строки уходят как «убрать поле»: иначе стёртое в форме значение вернулось бы.
    const body = { kind, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === undefined ? "" : v])),
                   deck: deck ? Number(deck) : null };
    try {
      if (note) await api.updateNote(note.id, body);
      else await api.createNote(body);
      onSaved(); onClose();
    } catch (err) { notify((err as Error).message || t("failed")); }
    setBusy(false);
  };

  const remove = async () => {
    if (!note) return;
    if (!confirm) return setConfirm(true);
    try { await api.removeNote(note.id); onSaved(); onClose(); }
    catch (err) { notify((err as Error).message || t("failed")); }
  };

  const retry = async () => {
    if (!note) return;
    try { await api.retryNote(note.id); notify(t("retry_sent")); onSaved(); onClose(); }
    catch (err) { notify((err as Error).message || t("failed")); }
  };

  const toggle = async (c: CardState) => {
    try {
      await api.suspend(c.id, !c.suspended);
      setCards((list) => list.map((x) => x.id === c.id
        ? { ...x, suspended: !c.suspended, leech: c.suspended ? false : x.leech } : x));
      onSaved();
    } catch (err) { notify((err as Error).message || t("failed")); }
  };

  const unfilled = note && note.status !== "ready";

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <form className="modal wide" onMouseDown={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="modal-head">
          <h2>{note ? t("edit_card") : t("new_card")}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("close")}><X size={16} /></button>
        </div>

        {unfilled && (
          <div className={"banner" + (note.status === "failed" ? " warn" : "")}>
            <span>{note.status === "failed" ? t("fill_failed", note.error) : t("fill_pending")}</span>
            {note.status === "failed" && (
              <button type="button" className="link-btn" onClick={retry}><RefreshCw size={13} />{t("retry")}</button>
            )}
          </div>
        )}
        {unfilled && note.source.quote && <blockquote className="quote">{note.source.quote}</blockquote>}

        <div className="seg">
          {KINDS.map((k) => (
            <button type="button" key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{t(("kind_" + k) as "kind_word")}</button>
          ))}
        </div>

        {kind === "word" && (
          <div className="grid2">
            {WORD.map((w) => (
              <label key={w.key} className={"fld" + (w.wide ? " span" : "")}>
                <span>{t(w.label as "f_word")}</span>
                {w.area
                  ? <textarea rows={2} value={val(w.key)} onChange={(e) => set(w.key, e.target.value)} />
                  : <input value={val(w.key)} onChange={(e) => set(w.key, e.target.value)} autoFocus={w.key === "word" && !note} />}
              </label>
            ))}
          </div>
        )}

        {kind === "basic" && (
          <>
            <label className="fld">
              <span>{t("f_front")}</span>
              <textarea rows={2} value={val("front")} onChange={(e) => set("front", e.target.value)} autoFocus={!note} />
            </label>
            <label className="fld">
              <span>{t("f_back")}</span>
              <textarea rows={3} value={val("back")} onChange={(e) => set("back", e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={!!fields.reverse} onChange={(e) => set("reverse", e.target.checked)} />
              {t("f_reverse")}
            </label>
          </>
        )}

        {kind === "cloze" && (
          <>
            <label className="fld">
              <span>{t("f_text")}</span>
              <textarea ref={clozeRef} rows={4} value={val("text")} onChange={(e) => set("text", e.target.value)}
                placeholder={t("f_text_ph")} autoFocus={!note} />
            </label>
            <div className="fld-row tight">
              <button type="button" className="btn ghost sm" onClick={hide}>{t("hide_selection")}</button>
              <span className="fld-hint">{t("cloze_count", numbers(val("text")).length)}</span>
            </div>
            <label className="fld">
              <span>{t("f_extra")}</span>
              <input value={val("extra")} onChange={(e) => set("extra", e.target.value)} />
            </label>
          </>
        )}

        <label className="fld">
          <span>{t("deck")}</span>
          <select value={deck} onChange={(e) => setDeck(e.target.value)}>
            <option value="">{t("deck_auto")}</option>
            {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>

        {cards.length > 0 && (
          <div className="card-states">
            {cards.map((c) => (
              <div key={c.id} className={"card-state" + (c.suspended ? " off" : "")}>
                <span className="cs-name">{tplName(kind, c.tpl)}</span>
                <span className="cs-info">{stateLabel(c)}{c.lapses > 0 && ` · ${t("lapses", c.lapses)}`}</span>
                <button type="button" className="icon-btn sm" onClick={() => toggle(c)}
                  title={c.suspended ? t("resume") : t("suspend")} aria-label={c.suspended ? t("resume") : t("suspend")}>
                  {c.suspended ? <Play size={13} /> : <Pause size={13} />}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="modal-foot">
          {note && (
            <button type="button" className={"btn danger" + (confirm ? " sure" : "")} onClick={remove}>
              <Trash2 size={14} />{confirm ? t("delete_sure") : t("delete")}
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn primary" disabled={busy}>{t("save")}</button>
        </div>
      </form>
    </div>
  );
}
