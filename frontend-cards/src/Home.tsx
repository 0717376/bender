import { useState } from "react";
import { ArrowRight, Flame, Inbox, Play, Plus, Settings2, Sparkles, TriangleAlert } from "lucide-react";
import { api } from "./api";
import { spent } from "./fmt";
import { lang, plural, t, weekday } from "./i18n";
import type { Deck, Overview } from "./types";

/** Счётчики колоды: новые, доучиваемые, повторы — тем же цветом, что и в сессии. */
function Dots({ c }: { c: Deck["counts"] }) {
  if (!c.total) return <span className="deck-clear">{t("all_done")}</span>;
  return (
    <span className="rv-counts">
      {c.new > 0 && <span className="c-new">{c.new}</span>}
      {c.learning > 0 && <span className="c-learn">{c.learning}</span>}
      {c.review > 0 && <span className="c-review">{c.review}</span>}
    </span>
  );
}

export default function Home({ o, onReview, onDeck, onBrowse, onNewDeck, notify, reload }: {
  o: Overview;
  onReview: (deck?: number) => void;
  onDeck: (d: Deck) => void;
  onBrowse: (filter: "inbox" | "leech") => void;
  onNewDeck: () => void;
  notify: (text: string) => void;
  reload: () => void;
}) {
  const [quick, setQuick] = useState("");
  const [adding, setAdding] = useState(false);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = quick.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      await api.quick(text, lang);
      setQuick("");
      notify(t("quick_added"));
      reload();
    } catch (err) {
      notify((err as Error).message || t("failed"));
    }
    setAdding(false);
  };

  const due = o.due.total;
  const peak = Math.max(1, ...o.forecast.map((d) => d.n));

  return (
    <div className="home">
      <section className={"hero" + (due ? "" : " calm")}>
        <div className="hero-aura" />
        <div className="hero-main">
          <div className="hero-label">{due ? t("due_today") : t("today")}</div>
          <div className="hero-num">{due || t("all_clear")}</div>
          <div className="hero-sub">
            {due ? (
              <>
                {o.due.review > 0 && <span><i className="dot c-review" />{plural(o.due.review, "to_review")}</span>}
                {o.due.learning > 0 && <span><i className="dot c-learn" />{plural(o.due.learning, "to_learn")}</span>}
                {o.due.new > 0 && <span><i className="dot c-new" />{plural(o.due.new, "new_cards")}</span>}
              </>
            ) : (
              <span>{o.decks.length ? t("all_clear_hint") : t("empty_hint")}</span>
            )}
          </div>
          {due > 0 && (
            <button className="btn primary big" onClick={() => onReview()}>
              <Play size={16} fill="currentColor" strokeWidth={0} />{t("start")}
            </button>
          )}
        </div>
        <div className="hero-side">
          <div className="pill-stat">
            <Flame size={16} strokeWidth={2} />
            <b>{o.streak.current}</b>
            <span>{plural(o.streak.current, "streak_days", true)}</span>
          </div>
          {o.today.n > 0 && (
            <div className="hero-today">
              {t("today_done", plural(o.today.n, "cards"))}{o.today.ms > 0 && " · " + spent(o.today.ms)}
            </div>
          )}
        </div>
      </section>

      <form className="quick" onSubmit={add}>
        <Sparkles size={16} strokeWidth={2} />
        <input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder={t("quick_ph")} />
        <button type="submit" disabled={!quick.trim() || adding} aria-label={t("add")}>
          {adding ? <span className="spin" /> : <ArrowRight size={16} strokeWidth={2.4} />}
        </button>
      </form>

      {(o.inbox > 0 || o.leeches > 0) && (
        <div className="notices">
          {o.inbox > 0 && (
            <button className="notice" onClick={() => onBrowse("inbox")}>
              <Inbox size={15} />{t("inbox_notice", plural(o.inbox, "cards"))}
            </button>
          )}
          {o.leeches > 0 && (
            <button className="notice warn" onClick={() => onBrowse("leech")}>
              <TriangleAlert size={15} />{t("leech_notice", plural(o.leeches, "cards"))}
            </button>
          )}
        </div>
      )}

      <section className="block">
        <div className="block-head">
          <h2>{t("decks")}</h2>
          <button className="link-btn" onClick={onNewDeck}><Plus size={14} strokeWidth={2.4} />{t("new_deck")}</button>
        </div>
        {o.decks.length === 0 && <div className="empty">{t("no_decks")}</div>}
        <div className="decks">
          {o.decks.map((d) => (
            <div key={d.id} className="deck" role="button" tabIndex={0}
              onClick={() => onReview(d.id)}
              onKeyDown={(e) => { if (e.key === "Enter") onReview(d.id); }}>
              <div className="deck-top">
                <span className="deck-name">{d.name}</span>
                <button className="icon-btn sm" onClick={(e) => { e.stopPropagation(); onDeck(d); }}
                  aria-label={t("deck_settings")} title={t("deck_settings")}><Settings2 size={14} /></button>
              </div>
              {d.descr && <div className="deck-descr">{d.descr}</div>}
              <div className="deck-bot">
                <Dots c={d.counts} />
                <span className="deck-total">{plural(d.cards, "cards")}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="block">
        <div className="block-head"><h2>{t("week_ahead")}</h2></div>
        <div className="forecast">
          {o.forecast.map((d, i) => (
            <div key={d.day} className={"fc" + (i === 0 ? " today" : "")} title={plural(d.n, "cards")}>
              <span className="fc-n">{d.n || ""}</span>
              <span className="fc-bar"><i style={{ height: `${Math.max(d.n ? 8 : 2, (d.n / peak) * 100)}%` }} /></span>
              <span className="fc-day">{i === 0 ? t("today_short") : weekday(d.day)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
