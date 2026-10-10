import { useEffect, useState } from "react";
import { api } from "./api";
import { spent } from "./fmt";
import { plural, shortDate, t, weekday } from "./i18n";
import type { Stats as Data } from "./types";

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

/** Недели колонками, с понедельника: от первого дня окна до сегодняшнего. */
export function weeks(from: string, today: string): (string | null)[][] {
  const out: (string | null)[][] = [];
  const end = parse(today);
  const d = parse(from);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  while (d <= end) {
    const col: (string | null)[] = [];
    for (let i = 0; i < 7; i++) {
      const day = iso(d);
      col.push(day >= from && day <= today ? day : null);
      d.setDate(d.getDate() + 1);
    }
    out.push(col);
  }
  return out;
}

/** Насыщенность плитки: четыре ступени от самого загруженного дня окна. */
export const level = (n: number, peak: number): number => (n <= 0 ? 0 : Math.min(4, Math.ceil((n / peak) * 4)));

const MATURITY = ["new", "learning", "young", "mature", "suspended"] as const;

export default function Stats({ version }: { version: number }) {
  const [s, setS] = useState<Data | null>(null);
  useEffect(() => { api.stats().then(setS).catch(() => {}); }, [version]);

  if (!s) return <div className="rv-loading"><span className="spin" /></div>;

  const byDay = new Map(s.days.map((d) => [d.day, d]));
  const peak = Math.max(1, ...s.days.map((d) => d.n));
  const grid = weeks(s.from, s.today);
  const total = MATURITY.reduce((a, k) => a + s.maturity[k], 0);
  const fcPeak = Math.max(1, ...s.forecast.map((d) => d.n));
  const rate = s.retention.rate;

  return (
    <div className="stats">
      <div className="tiles">
        <div className="tile">
          <span className="tile-k">{t("streak")}</span>
          <b>{s.streak.current}</b>
          <span className="tile-s">{plural(s.streak.current, "days", true)}</span>
        </div>
        <div className="tile">
          <span className="tile-k">{t("best_streak")}</span>
          <b>{s.streak.best}</b>
          <span className="tile-s">{plural(s.streak.best, "days", true)}</span>
        </div>
        <div className="tile">
          <span className="tile-k">{t("total_reviews")}</span>
          <b>{s.totals.reviews}</b>
          <span className="tile-s">{s.totals.ms > 0 ? spent(s.totals.ms) : " "}</span>
        </div>
        <div className="tile accent">
          <span className="tile-k">{t("recall_rate")}</span>
          <b>{rate == null ? "—" : Math.round(rate * 100) + "%"}</b>
          <span className="tile-s">{rate == null ? t("recall_none") : `${s.retention.kept} / ${s.retention.seen}`}</span>
        </div>
      </div>

      <section className="block">
        <div className="block-head"><h2>{t("activity")}</h2></div>
        {s.totals.reviews === 0 && <div className="empty">{t("no_stats")}</div>}
        <div className="heat-wrap">
          <div className="heat">
            {grid.map((col, i) => (
              <div key={i} className="heat-col">
                {col.map((day, j) => {
                  if (!day) return <i key={j} className="hc void" />;
                  const n = byDay.get(day)?.n ?? 0;
                  return <i key={j} className={"hc l" + level(n, peak) + (day === s.today ? " today" : "")}
                    title={`${shortDate(day)} · ${plural(n, "cards")}`} />;
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="heat-legend">
          {t("less")}{[0, 1, 2, 3, 4].map((l) => <i key={l} className={"hc l" + l} />)}{t("more")}
        </div>
      </section>

      <section className="block">
        <div className="block-head"><h2>{t("maturity")}</h2><span className="block-n">{plural(total, "cards")}</span></div>
        {total > 0 && (
          <div className="mat-bar">
            {MATURITY.map((k) => s.maturity[k] > 0 && <i key={k} className={"m-" + k} style={{ flexGrow: s.maturity[k] }} />)}
          </div>
        )}
        <div className="mat-legend">
          {MATURITY.map((k) => (
            <span key={k}><i className={"dot m-" + k} />{t(("m_" + k) as "m_new")}<b>{s.maturity[k]}</b></span>
          ))}
        </div>
      </section>

      <section className="block">
        <div className="block-head"><h2>{t("month_ahead")}</h2></div>
        <div className="forecast dense">
          {s.forecast.map((d, i) => (
            <div key={d.day} className={"fc" + (i === 0 ? " today" : "")} title={`${shortDate(d.day)} · ${plural(d.n, "cards")}`}>
              <span className="fc-bar"><i style={{ height: `${Math.max(d.n ? 8 : 2, (d.n / fcPeak) * 100)}%` }} /></span>
              <span className="fc-day">{i % 7 === 0 ? (i === 0 ? t("today_short") : weekday(d.day)) : ""}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
