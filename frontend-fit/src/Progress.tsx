import { useEffect, useState } from "react";
import { api } from "./api";
import LineChart from "./Chart";
import { exName, hours, kg, mins, num, setText } from "./fmt";
import { plural, shortDate, t } from "./i18n";
import type { BodyRow, Exercise, Kind, Progress as Prog, Recovery, Week } from "./types";

/** Сколько тяжёлых подходов на мышцу в неделю достаточно для роста — полоса «в самый раз». */
export const ENOUGH: [number, number] = [6, 10];

const MUSCLES = ["chest", "back", "shoulders", "biceps", "triceps", "quads", "hamstrings", "glutes", "calves", "core", "forearms"] as const;
const KINDS: Kind[] = ["strength", "cardio", "swim", "other"];

function Weeks({ weeks }: { weeks: Week[] }) {
  const top = Math.max(3, ...weeks.map((w) => w.sessions));
  return (
    <div className="weeks">
      {weeks.map((w, i) => (
        <div key={w.from} className="wk" title={`${shortDate(w.from)} · ${mins(w.minutes)}`}>
          <div className="wk-bar">
            {KINDS.map((k) => (w.by_kind[k] ?? 0) > 0 && (
              <i key={k} className={"k-" + k} style={{ height: `${((w.by_kind[k] ?? 0) / top) * 100}%` }} />
            ))}
          </div>
          <span className="wk-n">{w.sessions || ""}</span>
          <span className="wk-day">{i === weeks.length - 1 || i % 4 === 0 ? shortDate(w.from) : ""}</span>
        </div>
      ))}
    </div>
  );
}

function Muscles({ week }: { week: Week }) {
  const rows = MUSCLES.map((m) => ({ m, n: week.sets[m] ?? 0 })).filter((r) => r.n > 0);
  if (rows.length === 0) return <div className="empty">{t("no_sets_week")}</div>;
  const top = Math.max(ENOUGH[1] + 2, ...rows.map((r) => r.n));
  return (
    <div className="muscles">
      {rows.map(({ m, n }) => (
        <div key={m} className="mus">
          <span className="mus-name">{t(`m_${m}`)}</span>
          <div className="mus-track">
            <i className="mus-zone" style={{ left: `${(ENOUGH[0] / top) * 100}%`, width: `${((ENOUGH[1] - ENOUGH[0]) / top) * 100}%` }} />
            <i className={"mus-bar" + (n < ENOUGH[0] ? " low" : n > ENOUGH[1] ? " high" : "")} style={{ width: `${(n / top) * 100}%` }} />
          </div>
          <b>{num(n)}</b>
        </div>
      ))}
      <div className="fld-hint">{t("enough_hint", ENOUGH[0], ENOUGH[1])}</div>
    </div>
  );
}

function Strength({ used, version }: { used: Exercise[]; version: number }) {
  const [id, setId] = useState<number | null>(null);
  const [p, setP] = useState<Prog | null>(null);
  const current = id ?? used[0]?.id ?? null;
  useEffect(() => {
    if (current == null) return;
    let off = false;
    api.progress(current).then((r) => { if (!off) setP(r); }).catch(() => {});
    return () => { off = true; };
  }, [current, version]);
  if (used.length === 0) return <div className="empty">{t("no_strength_yet")}</div>;
  const time = p?.exercise.kind === "time";
  // У упражнений со своим весом и на время максимума нет — рисуем повторы или секунды лучшего подхода.
  const byReps = !!p && p.points.every((x) => !x.e1rm);
  const first = p?.points[0], last = p?.points[p.points.length - 1];
  const delta = first && last && !byReps && p!.points.length > 1 ? last.e1rm - first.e1rm : null;
  return (
    <div className="panel">
      <div className="panel-head">
        <select value={current ?? ""} onChange={(e) => { setP(null); setId(Number(e.target.value)); }}>
          {used.map((e) => <option key={e.id} value={e.id}>{exName(e)}</option>)}
        </select>
        {delta != null && (
          <span className={"delta" + (delta > 0 ? " up" : delta < 0 ? " down" : "")}>
            {delta > 0 ? "+" : ""}{num(delta)} {t("u_kg")}
          </span>
        )}
      </div>
      {p && p.exercise.id === current && (
        <>
          <LineChart id="g-str" digits={byReps ? 0 : 1}
            points={p.points.map((x) => ({ day: x.day, y: byReps ? x.reps : x.e1rm }))} />
          <div className="panel-foot">
            <span>{t(byReps ? (time ? "chart_seconds" : "chart_reps") : "chart_e1rm")}</span>
            {p.best && (
              <span>{t("best")}: <b>{setText(p.best.weight, p.best.reps, p.exercise.kind)}</b> · {shortDate(p.best.day)}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Body({ rows }: { rows: BodyRow[] }) {
  if (rows.length < 2) return null;
  const d = rows[rows.length - 1].weight - rows[0].weight;
  return (
    <section className="block">
      <div className="block-head">
        <h2>{t("body_weight")}</h2>
        <span className="block-n">{kg(rows[rows.length - 1].weight)} · {d > 0 ? "+" : ""}{num(d)} {t("u_kg")}</span>
      </div>
      <div className="panel"><LineChart id="g-body" points={rows.map((r) => ({ day: r.day, y: r.weight }))} height={150} /></div>
    </section>
  );
}

function Ring({ rec, marks }: { rec: Recovery; marks: string[] }) {
  const days = rec.days ?? [];
  const series: { key: string; label: string; pick: (d: (typeof days)[number]) => number | null; show: (v: number) => string; color: string; digits: number }[] = [
    { key: "readiness", label: t("readiness"), pick: (d) => d.readiness, show: (v) => num(v, 0), color: "var(--accent)", digits: 0 },
    { key: "sleep", label: t("sig_sleep"), pick: (d) => (d.sleep_sec == null ? null : d.sleep_sec / 3600), show: (v) => hours(v * 3600), color: "var(--c-new)", digits: 1 },
    { key: "hrv", label: t("sig_hrv"), pick: (d) => d.hrv, show: (v) => num(v, 0), color: "var(--c-review)", digits: 0 },
    { key: "rhr", label: t("sig_rhr"), pick: (d) => d.rhr, show: (v) => num(v, 0), color: "var(--c-again)", digits: 0 },
  ];
  const ready = series.map((s) => ({ ...s, pts: days.flatMap((d) => { const y = s.pick(d); return y == null ? [] : [{ day: d.day, y }]; }) }))
    .filter((s) => s.pts.length > 1);
  if (ready.length === 0) return null;
  return (
    <section className="block">
      <div className="block-head"><h2>{t("recovery_30")}</h2><span className="block-n">{t("marks_hint")}</span></div>
      <div className="ring-grid">
        {ready.map((s) => (
          <div key={s.key} className="panel small">
            <div className="panel-head"><span>{s.label}</span><b>{s.show(s.pts[s.pts.length - 1].y)}</b></div>
            <LineChart id={"g-" + s.key} points={s.pts} height={120} digits={s.digits} color={s.color} marks={marks} />
          </div>
        ))}
      </div>
    </section>
  );
}

export default function Progress({ version }: { version: number }) {
  const [weeks, setWeeks] = useState<Week[] | null>(null);
  const [used, setUsed] = useState<Exercise[]>([]);
  const [body, setBody] = useState<BodyRow[]>([]);
  const [rec, setRec] = useState<Recovery | null>(null);
  useEffect(() => {
    api.weeks(12).then(setWeeks).catch(() => {});
    api.usedExercises().then(setUsed).catch(() => {});
    api.body().then(setBody).catch(() => {});
    api.recovery(30).then(setRec).catch(() => {});
  }, [version]);

  if (!weeks) return <div className="rv-loading"><span className="spin" /></div>;
  const now = weeks[weeks.length - 1];
  const total = weeks.reduce((a, w) => a + w.sessions, 0);
  const marks = weeks.flatMap((w) => Object.keys(w.days));

  return (
    <>
      <section className="block first">
        <div className="block-head">
          <h2>{t("weeks_12")}</h2>
          <span className="block-n">{total ? plural(total, "workouts") : t("week_empty")}</span>
        </div>
        <div className="panel">
          <Weeks weeks={weeks} />
          <div className="legend">
            {KINDS.filter((k) => weeks.some((w) => w.by_kind[k])).map((k) => (
              <span key={k}><i className={"k-" + k} />{t(`kind_${k}`)}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="block">
        <div className="block-head"><h2>{t("strength")}</h2></div>
        <Strength used={used} version={version} />
      </section>

      <section className="block">
        <div className="block-head">
          <h2>{t("sets_by_muscle")}</h2>
          <span className="block-n">{t("this_week")}</span>
        </div>
        <div className="panel"><Muscles week={now} /></div>
      </section>

      <Body rows={body} />
      {rec && <Ring rec={rec} marks={marks} />}
    </>
  );
}
