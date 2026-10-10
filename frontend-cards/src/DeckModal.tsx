import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { api } from "./api";
import { t } from "./i18n";
import type { Deck } from "./types";

/** Настройки колоды — или новая колода, если deck не передан. */
export default function DeckModal({ deck, onClose, onSaved, notify }: {
  deck: Deck | null; onClose: () => void; onSaved: () => void; notify: (text: string) => void;
}) {
  const [name, setName] = useState(deck?.name ?? "");
  const [descr, setDescr] = useState(deck?.descr ?? "");
  const [perDay, setPerDay] = useState(deck?.new_per_day ?? 15);
  const [retention, setRetention] = useState(Math.round((deck?.retention ?? 0.9) * 100));
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const d = deck ?? await api.createDeck(name.trim());
      await api.updateDeck(d.id, { name: name.trim(), descr, new_per_day: perDay, retention: retention / 100 });
      onSaved(); onClose();
    } catch (err) { notify((err as Error).message || t("failed")); }
  };

  const remove = async () => {
    if (!deck) return;
    if (!confirm) return setConfirm(true);
    try { await api.removeDeck(deck.id); onSaved(); onClose(); }
    catch (err) { notify((err as Error).message || t("failed")); }
  };

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="modal-head">
          <h2>{deck ? t("deck_settings") : t("new_deck")}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("close")}><X size={16} /></button>
        </div>
        <label className="fld">
          <span>{t("deck_name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={t("deck_name_ph")} />
        </label>
        <label className="fld">
          <span>{t("deck_descr")}</span>
          <input value={descr} onChange={(e) => setDescr(e.target.value)} placeholder={t("deck_descr_ph")} />
        </label>
        <div className="fld-row">
          <label className="fld">
            <span>{t("new_per_day")}</span>
            <input type="number" min={0} max={500} value={perDay} onChange={(e) => setPerDay(Number(e.target.value))} />
          </label>
          <label className="fld">
            <span>{t("retention")} · {retention}%</span>
            <input type="range" min={70} max={97} value={retention} onChange={(e) => setRetention(Number(e.target.value))} />
          </label>
        </div>
        <div className="fld-hint">{t("retention_hint")}</div>
        <div className="modal-foot">
          {deck && (
            <button type="button" className={"btn danger" + (confirm ? " sure" : "")} onClick={remove}>
              <Trash2 size={14} />{confirm ? t("delete_sure") : t("delete_deck")}
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>{t("save")}</button>
        </div>
      </form>
    </div>
  );
}
