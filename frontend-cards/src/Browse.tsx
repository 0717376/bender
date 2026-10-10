import { useCallback, useEffect, useState } from "react";
import { BookOpen, Languages, MessageCircleQuestion, Plus, Search, TextCursorInput } from "lucide-react";
import { api } from "./api";
import { plain } from "./cloze";
import { dueIn } from "./fmt";
import { plural, t } from "./i18n";
import { LEARNING, NEW, RELEARNING } from "./types";
import type { Deck, Note } from "./types";

export type Filter = "all" | "inbox" | "leech";

const ICON = { word: Languages, basic: MessageCircleQuestion, cloze: TextCursorInput };

function title(n: Note): [string, string] {
  const f = n.fields as Record<string, string>;
  if (n.kind === "word") return [f.word || n.source.quote || "", f.meaning || ""];
  if (n.kind === "cloze") return [plain(f.text || ""), ""];
  return [f.front || n.source.quote || "", f.back || ""];
}

function status(n: Note): { text: string; cls: string } {
  if (n.status === "draft") return { text: t("st_filling"), cls: "wait" };
  if (n.status === "failed") return { text: t("st_failed"), cls: "bad" };
  const cards = n.cards ?? [];
  if (cards.some((c) => c.leech)) return { text: t("st_leech"), cls: "bad" };
  if (cards.length && cards.every((c) => c.suspended)) return { text: t("st_suspended"), cls: "mute" };
  if (cards.every((c) => c.state === NEW)) return { text: t("st_new"), cls: "new" };
  if (cards.some((c) => c.state === LEARNING || c.state === RELEARNING)) return { text: t("st_learning"), cls: "learn" };
  const next = Math.min(...cards.filter((c) => c.due != null).map((c) => c.due as number));
  if (!isFinite(next)) return { text: "", cls: "ok" };
  return { text: next <= Date.now() ? t("st_due") : dueIn(next), cls: "ok" };
}

/** Все карточки: поиск, «Входящие» (ждут заполнения) и «Требуют внимания» (не даются). */
export default function Browse({ decks, filter, onFilter, version, onOpen, onNew }: {
  decks: Deck[]; filter: Filter; onFilter: (f: Filter) => void; version: number;
  onOpen: (n: Note) => void; onNew: (deckId?: number) => void;
}) {
  const [q, setQ] = useState("");
  const [deck, setDeck] = useState("");
  const [notes, setNotes] = useState<Note[] | null>(null);

  const load = useCallback(() => {
    api.notes({
      q, deck: deck ? Number(deck) : undefined,
      status: filter === "inbox" ? "inbox" : undefined, leech: filter === "leech",
    }).then(setNotes).catch(() => setNotes([]));
  }, [q, deck, filter]);

  // Поиск — с паузой после последней буквы; правки со стороны (version) — сразу.
  useEffect(() => { const id = setTimeout(load, q ? 220 : 0); return () => clearTimeout(id); }, [load, q, version]);

  const deckName = (id: number) => decks.find((d) => d.id === id)?.name ?? "";

  return (
    <div className="browse">
      <div className="browse-bar">
        <div className="search">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search_ph")} />
        </div>
        <select value={deck} onChange={(e) => setDeck(e.target.value)} aria-label={t("deck")}>
          <option value="">{t("all_decks")}</option>
          {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button className="btn primary" onClick={() => onNew(deck ? Number(deck) : undefined)}>
          <Plus size={15} strokeWidth={2.4} />{t("new_card")}
        </button>
      </div>
      <div className="tabs">
        {(["all", "inbox", "leech"] as Filter[]).map((f) => (
          <button key={f} className={filter === f ? "on" : ""} onClick={() => onFilter(f)}>{t(("tab_" + f) as "tab_all")}</button>
        ))}
        {notes && <span className="tabs-n">{plural(notes.length, "notes")}</span>}
      </div>

      {notes && notes.length === 0 && (
        <div className="empty">{q ? t("nothing_found") : filter === "inbox" ? t("inbox_empty") : filter === "leech" ? t("leech_empty") : t("no_cards")}</div>
      )}

      <ul className="notes">
        {(notes ?? []).map((n) => {
          const [main, sub] = title(n);
          const st = status(n);
          const Icon = ICON[n.kind];
          return (
            <li key={n.id}>
              <button className="note" onClick={() => onOpen(n)}>
                <span className="note-ic"><Icon size={15} strokeWidth={1.9} /></span>
                <span className="note-body">
                  <span className="note-main">{main || t("untitled")}</span>
                  {sub && <span className="note-sub">{sub}</span>}
                </span>
                <span className="note-side">
                  {n.source.title && <span className="note-src"><BookOpen size={12} />{n.source.title}</span>}
                  <span className="note-deck">{deckName(n.deck_id)}</span>
                  {st.text && <span className={"badge " + st.cls}>{st.text}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
