import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Clock, Pencil, Undo2, X } from "lucide-react";
import { api } from "./api";
import CardFace, { speak } from "./CardFace";
import { interval, spent } from "./fmt";
import { plural, t } from "./i18n";
import type { Session } from "./types";

const RATINGS = [
  { r: 1, key: "again", cls: "again" },
  { r: 2, key: "hard", cls: "hard" },
  { r: 3, key: "good", cls: "good" },
  { r: 4, key: "easy", cls: "easy" },
] as const;

// Сдвиг пальцем: вправо — «хорошо», влево — «снова». Двух оценок жесту хватает:
// «трудно» и «легко» — осознанный выбор, для него есть кнопки.
const SWIPE = 96;

/** Сессия повторения — режим фокуса: одна карточка, вопрос, ответ, оценка. */
export default function Review({ deck, deckName, refresh, onExit, onEdit }: {
  /** refresh растёт, когда карточку поправили посреди сессии: её надо перечитать. */
  deck?: number; deckName?: string; refresh: number; onExit: () => void; onEdit: (noteId: number) => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stat, setStat] = useState({ done: 0, again: 0, started: Date.now() });
  const [drag, setDrag] = useState(0);
  const [leech, setLeech] = useState(false);
  const shownAt = useRef(Date.now());
  const dragFrom = useRef<number | null>(null);

  const show = useCallback((s: Session) => {
    setSession(s); setOpen(false); setDrag(0);
    shownAt.current = Date.now();
  }, []);

  useEffect(() => { api.next(deck).then(show).catch(() => {}); }, [deck, show, refresh]);

  const card = session?.card ?? null;

  const answer = useCallback(async (rating: number) => {
    if (!card || busy) return;
    setBusy(true);
    try {
      const res = await api.answer(card.id, rating, Date.now() - shownAt.current, deck);
      setStat((s) => ({ ...s, done: s.done + 1, again: s.again + (rating === 1 ? 1 : 0) }));
      setLeech(res.result.leech);
      show(res);
    } catch { /* сеть моргнула — карточка осталась на месте, можно нажать ещё раз */ }
    setBusy(false);
  }, [card, busy, deck, show]);

  const undo = useCallback(async () => {
    if (busy || !stat.done) return;
    setBusy(true);
    try {
      show(await api.undo(deck));
      setStat((s) => ({ ...s, done: Math.max(0, s.done - 1) }));
      setLeech(false);
    } catch { /* отменять нечего */ }
    setBusy(false);
  }, [busy, stat.done, deck, show]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") return onExit();
      if (e.key === "z" || e.key === "я" || (e.key === "z" && (e.metaKey || e.ctrlKey))) return void undo();
      if (!card) return;
      if (!open && (e.key === " " || e.key === "Enter")) { e.preventDefault(); return setOpen(true); }
      if (open && ["1", "2", "3", "4"].includes(e.key)) return void answer(Number(e.key));
      if (open && (e.key === " " || e.key === "Enter")) { e.preventDefault(); return void answer(3); }
      if ((e.key === "s" || e.key === "ы") && card.kind === "word") speak(String(card.fields.word ?? ""), String(card.fields.lang ?? "en"));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [card, open, answer, undo, onExit]);

  // Показывать нечего, но доучиваемая карточка на подходе — ждём её и забираем сами.
  const waiting = !card && session?.waiting ? session.waiting : null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => {
      tick((x) => x + 1);
      if (Date.now() >= waiting) api.next(deck).then(show).catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, [waiting, deck, show]);

  const left = session?.counts.total ?? 0;
  const progress = stat.done + left ? stat.done / (stat.done + left) : 1;

  const onDown = (e: React.PointerEvent) => {
    if (!open || e.pointerType === "mouse") return;
    dragFrom.current = e.clientX;
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragFrom.current == null) return;
    setDrag(e.clientX - dragFrom.current);
  };
  const onUp = () => {
    if (dragFrom.current == null) return;
    dragFrom.current = null;
    if (drag > SWIPE) void answer(3);
    else if (drag < -SWIPE) void answer(1);
    else setDrag(0);
  };

  return (
    <div className="rv">
      <header className="rv-top">
        <button className="icon-btn" onClick={onExit} aria-label={t("close")} title={t("close")}><X size={18} /></button>
        <div className="rv-progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
        {session && (
          <div className="rv-counts" title={t("counts_hint")}>
            <span className="c-new">{session.counts.new}</span>
            <span className="c-learn">{session.counts.learning}</span>
            <span className="c-review">{session.counts.review}</span>
          </div>
        )}
        <button className="icon-btn" onClick={undo} disabled={!stat.done || busy} aria-label={t("undo")} title={t("undo") + " · Z"}>
          <Undo2 size={17} />
        </button>
      </header>

      <main className="rv-stage">
        {!session && <div className="rv-loading"><span className="spin" /></div>}

        {card && (
          <div
            key={card.id + ":" + stat.done}
            className={"rv-card" + (open ? " open" : "") + (drag > 30 ? " to-good" : drag < -30 ? " to-again" : "")}
            style={drag ? { transform: `translateX(${drag}px) rotate(${drag / 40}deg)`, transition: "none" } : undefined}
            onClick={() => !open && setOpen(true)}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          >
            <div className="rv-meta">
              <span className="rv-deck">{card.deck}</span>
              <button className="icon-btn sm" onClick={(e) => { e.stopPropagation(); onEdit(card.note_id); }}
                aria-label={t("edit")} title={t("edit")}><Pencil size={14} /></button>
            </div>
            <CardFace kind={card.kind} fields={card.fields} tpl={card.tpl} source={card.source} open={open} />
            {!open && <div className="rv-tap">{t("tap_to_reveal")}</div>}
          </div>
        )}

        {session && !card && waiting && (
          <div className="rv-done">
            <div className="rv-badge wait"><Clock size={26} strokeWidth={1.8} /></div>
            <h2>{t("almost_done")}</h2>
            <p>{t("waiting_cards", interval(Math.max(0, (waiting - Date.now()) / 1000)))}</p>
            <button className="btn ghost" onClick={onExit}>{t("come_back_later")}</button>
          </div>
        )}

        {session && !card && !waiting && (
          <div className="rv-done">
            <div className="rv-badge"><Check size={30} strokeWidth={2.2} /></div>
            <h2>{stat.done ? t("session_done") : t("nothing_due")}</h2>
            {stat.done > 0 && (
              <p>
                {plural(stat.done, "cards")} · {spent(Date.now() - stat.started)}
                {" · "}{t("accuracy", Math.round((1 - stat.again / stat.done) * 100))}
              </p>
            )}
            {!stat.done && <p>{deckName ? t("nothing_due_deck", deckName) : t("nothing_due_hint")}</p>}
            <button className="btn primary" onClick={onExit}>{t("done")}</button>
          </div>
        )}
      </main>

      {card && (
        <footer className="rv-foot">
          {leech && <div className="rv-note">{t("leech_note")}</div>}
          {!open ? (
            <button className="btn primary wide" onClick={() => setOpen(true)}>
              {t("show_answer")}<kbd>{t("key_space")}</kbd>
            </button>
          ) : (
            <div className="rv-rates">
              {RATINGS.map(({ r, key, cls }) => (
                <button key={r} className={"rate " + cls} disabled={busy} onClick={() => answer(r)}>
                  <span className="rate-iv">{interval(card.intervals[String(r)] ?? 0)}</span>
                  <span className="rate-nm">{t(key)}</span>
                  <kbd>{r}</kbd>
                </button>
              ))}
            </div>
          )}
        </footer>
      )}
    </div>
  );
}
