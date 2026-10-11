import { useState } from "react";
import {
  ArrowDown, ArrowUp, Check, Dumbbell, Footprints, HeartPulse, Moon, Play, Plus, Scale, Sparkles, Thermometer, Waves,
} from "lucide-react";
import { api } from "./api";
import { dayLabel, exName, hours, kg, mins, num, sessionTitle } from "./fmt";
import { plural, t, weekdayOf } from "./i18n";
import type { Kind, OuraStatus, Overview, PlanDay, PlanItem, Recovery, Session, Signal } from "./types";
import type { Workout } from "./live";

export const KIND_ICON: Record<Kind, typeof Dumbbell> = {
  strength: Dumbbell, cardio: Footprints, swim: Waves, other: HeartPulse,
};

const SIGNAL_ICON = { readiness: HeartPulse, sleep: Moon, temp: Thermometer, hrv: HeartPulse, rhr: HeartPulse } as const;

function signalValue(s: Signal): string {
  if (s.key === "sleep") return hours(s.value);
  if (s.key === "temp") return (s.value > 0 ? "+" : "") + num(s.value) + "°";
  return num(s.value, 0);
}

/** Полоса восстановления: готовность крупно, рядом — сон, вариабельность и пульс покоя против своей нормы. */
export function RecoveryStrip({ rec, oura, onSettings }: { rec: Recovery; oura: OuraStatus | null; onSettings: () => void }) {
  if (!rec.level || !rec.data) {
    if (!oura?.configured) return null;
    return (
      <button className="rec-empty" onClick={onSettings}>
        <HeartPulse size={16} />
        <span>{!oura.connected ? t(oura.error === "reauth" ? "oura_reauth" : "oura_connect_hint") : t("oura_no_night")}</span>
      </button>
    );
  }
  const d = rec.data;
  const state = (key: Signal["key"]) => rec.signals.find((s) => s.key === key);
  const chips: Signal["key"][] = ["sleep", "hrv", "rhr", "temp"];
  return (
    <section className={"rec " + rec.level}>
      <div className="rec-score">
        <b>{d.readiness ?? "—"}</b>
        <span>{t("readiness")}</span>
      </div>
      <div className="rec-body">
        <div className="rec-advice">{t(`advice_${rec.level}`)}</div>
        <div className="rec-chips">
          {chips.map((key) => {
            const s = state(key);
            if (!s) return null;
            const Icon = SIGNAL_ICON[key];
            return (
              <span key={key} className={"rec-chip " + s.state} title={s.base != null ? t("norm", num(s.base, 0)) : undefined}>
                <Icon size={13} strokeWidth={2.2} />
                <i>{t(`sig_${key}`)}</i>
                <b>{signalValue(s)}</b>
                {s.base != null && s.state !== "ok" && (s.value < s.base ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}

const HINT_ICON = { up: ArrowUp, down: ArrowDown } as const;

/** Цель на упражнение одной строкой: «3 × 82,5 кг × 6». */
export function targetText(i: PlanItem): string {
  const reps = i.reps ?? i.reps_min;
  if (i.kind === "time") return `${i.sets} × ${reps} ${t("u_sec")}`;
  return i.weight ? `${i.sets} × ${kg(i.weight)} × ${reps}` : `${i.sets} × ${i.reps_min}–${i.reps_max}`;
}

function PlanList({ plan }: { plan: PlanDay }) {
  return (
    <ul className="plan">
      {plan.items.map((i) => {
        const Icon = i.hint && i.hint in HINT_ICON ? HINT_ICON[i.hint as "up" | "down"] : null;
        return (
          <li key={i.id}>
            <span className="plan-name">{exName(i)}</span>
            <span className={"plan-target " + (i.hint ?? "")}>
              {Icon && <Icon size={13} strokeWidth={2.4} />}
              {targetText(i)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Сколько займёт силовой день: подходы с отдыхом и полминуты на сам подход. */
export const planMinutes = (p: PlanDay): number =>
  p.minutes || Math.round(p.items.reduce((a, i) => a + i.sets * (i.rest + 40) + 60, 0) / 60 / 5) * 5;

export function SessionRow({ s, today, onOpen }: { s: Session; today: string; onOpen?: () => void }) {
  const Icon = KIND_ICON[s.kind];
  const names = [...new Set(s.sets.filter((x) => !x.warm).map((x) => exName(x)))];
  return (
    <button className="sess" onClick={onOpen} disabled={!onOpen}>
      <span className={"sess-ic k-" + s.kind}><Icon size={16} strokeWidth={2.1} /></span>
      <span className="sess-main">
        <span className="sess-title">{sessionTitle(s)}</span>
        <span className="sess-sub">
          {[dayLabel(s.day, today),
            !!s.minutes && mins(s.minutes),
            s.work_sets > 0 && plural(s.work_sets, "sets"),
            s.distance != null && s.distance > 0 && `${num(s.distance / 1000, 2)} ${t("u_km")}`,
            s.avg_hr != null && `${s.avg_hr} ${t("u_bpm")}`,
          ].filter(Boolean).join(" · ")}
        </span>
        {names.length > 0 && <span className="sess-ex">{names.join(", ")}</span>}
      </span>
      {s.source === "oura" && <span className="tag">Oura</span>}
    </button>
  );
}

export default function Today({ o, oura, local, onStart, onResume, onLog, onAsk, onSettings, onOpen, reload, notify }: {
  o: Overview;
  oura: OuraStatus | null;
  local: Workout | null;
  onStart: (plan: PlanDay | null) => void;
  onResume: () => void;
  onLog: (plan: PlanDay | null) => void;
  onAsk: (text: string) => void;
  onSettings: () => void;
  onOpen: (s: Session) => void;
  reload: () => void;
  notify: (text: string) => void;
}) {
  // Облегчённый день предлагает приложение, а решает человек: «по плану» возвращает полные цели.
  const [full, setFull] = useState<PlanDay | null>(null);
  const plan = o.next && o.next.easy && full ? full : o.next;
  const running = local ?? o.active;
  const [weight, setWeight] = useState("");

  const backToPlan = async () => {
    if (!o.next) return;
    setFull(await api.plan(o.next.id, false).catch(() => null));
  };

  // Кольцо записало кардио, а день программы — как раз кардио: предложить засчитать.
  const ringMatch = plan && plan.kind !== "strength"
    ? o.today.find((s) => s.kind === plan.kind && !s.program_day_id) : undefined;
  const count = async (s: Session) => {
    if (!plan) return;
    await api.updateSession(s.id, { program_day_id: plan.id }).then(reload).catch((e) => notify(String(e.message)));
  };

  const saveWeight = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = Number(weight.replace(",", "."));
    if (!v) return;
    await api.logBody(v).then(() => { setWeight(""); reload(); }).catch((err) => notify(String(err.message)));
  };

  const week = o.week;
  const days = Array.from({ length: 7 }, (_, i) => {
    const [y, m, d] = week.from.split("-").map(Number);
    const date = new Date(y, m - 1, d + i);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { iso, kinds: week.days[iso] ?? [] };
  });
  const NextIcon = plan ? KIND_ICON[plan.kind] : Dumbbell;

  return (
    <>
      <RecoveryStrip rec={o.recovery} oura={oura} onSettings={onSettings} />

      {running ? (
        <section className="next live">
          <div className="next-aura" />
          <div className="next-label">{t("workout_running")}</div>
          <h2>{("dayName" in running ? running.dayName : running.day_name) || t("free_workout")}</h2>
          <button className="btn primary big" onClick={onResume}><Play size={17} fill="currentColor" />{t("resume")}</button>
        </section>
      ) : plan ? (
        <section className="next">
          <div className="next-aura" />
          <div className="next-label">{o.today.length ? t("next_up") : t("today_plan")}</div>
          <h2><NextIcon size={24} strokeWidth={2.2} />{plan.name}</h2>
          <div className="next-meta">
            {plan.kind === "strength" && plural(plan.items.length, "exercises") + " · "}
            {t("about_min", planMinutes(plan))}
          </div>
          {plan.easy && plan.kind !== "strength" && o.recovery.level === "rest" && (
            <div className="banner"><span>{t("easy_cardio")}</span></div>
          )}
          {plan.easy && plan.kind === "strength" && (
            <div className="banner">
              <span>{t(o.recovery.level === "rest" ? "easy_rest" : "easy_on")}</span>
              <button className="link-btn" onClick={backToPlan}>{t("by_plan")}</button>
            </div>
          )}
          {plan.kind === "strength" ? <PlanList plan={plan} /> : plan.note && <p className="next-note">{plan.note}</p>}
          {ringMatch && (
            <button className="btn ghost wide" onClick={() => count(ringMatch)}>
              <Check size={16} />{t("count_ring", sessionTitle(ringMatch), ringMatch.minutes ?? 0)}
            </button>
          )}
          {plan.kind === "strength"
            ? <button className="btn primary big" onClick={() => onStart(plan)}><Play size={17} fill="currentColor" />{t("start")}</button>
            : <button className="btn primary big" onClick={() => onLog(plan)}><Plus size={17} />{t("log_done")}</button>}
        </section>
      ) : (
        <section className="next calm">
          <div className="next-aura" />
          <div className="next-label">{t("no_program")}</div>
          <h2>{t("no_program_title")}</h2>
          <p className="next-note">{t("no_program_hint")}</p>
          <div className="next-actions">
            <button className="btn primary big" onClick={() => onAsk(t("ask_program"))}><Sparkles size={17} />{t("ask_program_btn")}</button>
            <button className="btn ghost big" onClick={() => onStart(null)}>{t("free_workout")}</button>
          </div>
        </section>
      )}

      {o.today.length > 0 && (
        <section className="block">
          <div className="block-head"><h2>{t("done_today")}</h2></div>
          <div className="sess-list">
            {o.today.map((s) => <SessionRow key={s.id} s={s} today={o.day} onOpen={() => onOpen(s)} />)}
          </div>
        </section>
      )}

      <section className="block">
        <div className="block-head">
          <h2>{t("this_week")}</h2>
          <span className="block-n">
            {week.sessions ? `${plural(week.sessions, "workouts")} · ${mins(week.minutes)}` : t("week_empty")}
          </span>
        </div>
        <div className="weekdots">
          {days.map(({ iso, kinds }) => (
            <div key={iso} className={"wd" + (iso === o.day ? " now" : "")}>
              <span className={"wd-dot" + (kinds.length ? " k-" + kinds[0] : "")}>
                {kinds.length > 0 && <Check size={14} strokeWidth={3} />}
              </span>
              <span className="wd-day">{weekdayOf(iso)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="block">
        <div className="block-head">
          <h2>{t("body_weight")}</h2>
          {o.body && <span className="block-n">{kg(o.body.weight)} · {dayLabel(o.body.day, o.day)}</span>}
        </div>
        <form className="quick" onSubmit={saveWeight}>
          <Scale size={17} />
          <input inputMode="decimal" placeholder={t("body_ph")} value={weight} onChange={(e) => setWeight(e.target.value)} />
          <button type="submit" disabled={!Number(weight.replace(",", "."))} aria-label={t("save")}><Check size={17} /></button>
        </form>
      </section>

      {!plan && !running && (
        <section className="block">
          <button className="link-btn" onClick={() => onLog(null)}><Plus size={15} />{t("log_other")}</button>
        </section>
      )}
    </>
  );
}
