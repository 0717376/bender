import { useEffect, useState } from "react";
import { Plus, Trash2, Trophy, X } from "lucide-react";
import { api, type LogBody } from "./api";
import { dayLabel, exName, km, mins, num, sessionTitle, setText } from "./fmt";
import { t } from "./i18n";
import { SessionRow } from "./Today";
import type { Kind, PlanDay, Session } from "./types";

const LOG_KINDS: Kind[] = ["cardio", "swim", "strength", "other"];

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}

export function Feel({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="feel">
      {([1, 2, 3, 4, 5] as const).map((n) => (
        <button key={n} type="button" className={value === n ? "on" : ""} onClick={() => onChange(value === n ? null : n)}>
          <b>{n}</b><span>{t(`feel_${n}`)}</span>
        </button>
      ))}
    </div>
  );
}

/** Записать сделанное без подходов: кардио, бассейн, тренировку по памяти. */
export function LogModal({ plan, today, onClose, onSaved, notify }: {
  plan: PlanDay | null; today: string; onClose: () => void; onSaved: () => void; notify: (text: string) => void;
}) {
  useEscape(onClose);
  const [kind, setKind] = useState<Kind>(plan?.kind ?? "cardio");
  const [day, setDay] = useState(today);
  const [minutes, setMinutes] = useState(plan?.minutes ? String(plan.minutes) : "");
  const [dist, setDist] = useState("");
  const [feel, setFeel] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const n = (s: string) => Number(s.replace(",", ".")) || undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: LogBody = {
      kind, day, minutes: n(minutes), distance_km: n(dist), feel: feel ?? undefined, note: note || undefined,
      program_day: plan ? String(plan.id) : undefined,
    };
    setBusy(true);
    try {
      await api.log(body);
      onSaved();
      onClose();
    } catch (err) {
      notify(String((err as Error).message));
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h2>{plan ? plan.name : t("log_title")}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("close")}><X size={16} /></button>
        </div>
        {!plan && (
          <div className="seg">
            {LOG_KINDS.map((k) => (
              <button key={k} type="button" className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{t(`kind_${k}`)}</button>
            ))}
          </div>
        )}
        <div className="grid2">
          <label className="fld">
            <span>{t("minutes")}</span>
            <input inputMode="decimal" value={minutes} onChange={(e) => setMinutes(e.target.value)} autoFocus />
          </label>
          <label className="fld">
            <span>{t("distance_km")}</span>
            <input inputMode="decimal" value={dist} onChange={(e) => setDist(e.target.value)} />
          </label>
        </div>
        <label className="fld">
          <span>{t("date")}</span>
          <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} />
        </label>
        <div className="stm-label">{t("feel")}</div>
        <Feel value={feel} onChange={setFeel} />
        <label className="fld">
          <span>{t("note")}</span>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="modal-foot">
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="btn primary" disabled={busy || !n(minutes)}>{t("save")}</button>
        </div>
      </form>
    </div>
  );
}

/** Тренировка целиком: подходы по упражнениям, пульс, самочувствие и заметка. */
export function SessionModal({ id, today, onClose, onChanged, notify }: {
  id: number; today: string; onClose: () => void; onChanged: () => void; notify: (text: string) => void;
}) {
  useEscape(onClose);
  const [s, setS] = useState<Session | null>(null);
  const [note, setNote] = useState("");
  const [sure, setSure] = useState(false);
  useEffect(() => {
    api.session(id).then((x) => { setS(x); setNote(x.note); }).catch(() => onClose());
  }, [id, onClose]);
  if (!s) return null;

  const patch = (body: { note?: string; feel?: number }) =>
    api.updateSession(id, body).then((x) => { setS({ ...x, records: s.records }); onChanged(); })
      .catch((e) => notify(String(e.message)));
  const remove = async () => {
    if (!sure) return setSure(true);
    await api.removeSession(id).then(() => { onChanged(); onClose(); }).catch((e) => notify(String(e.message)));
  };

  const groups: { id: number; name: string; kind: "strength" | "time"; sets: Session["sets"] }[] = [];
  for (const x of s.sets) {
    const g = groups.find((q) => q.id === x.exercise_id);
    if (g) g.sets.push(x);
    else groups.push({ id: x.exercise_id, name: exName(x), kind: x.kind, sets: [x] });
  }
  const facts = [
    !!s.minutes && mins(s.minutes),
    s.distance != null && s.distance > 0 && km(s.distance),
    s.calories != null && s.calories > 0 && `${num(s.calories, 0)} ${t("u_kcal")}`,
    s.avg_hr != null && `${t("pulse")} ${s.avg_hr}${s.max_hr ? ` / ${s.max_hr}` : ""}`,
    s.volume > 0 && `${num(s.volume / 1000, 1)} ${t("u_t")}`,
  ].filter(Boolean);

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{sessionTitle(s)} <span className="modal-sub">{dayLabel(s.day, today)}</span></h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("close")}><X size={16} /></button>
        </div>
        {facts.length > 0 && <div className="facts">{facts.map((f) => <span key={String(f)}>{f}</span>)}</div>}
        {s.records && s.records.length > 0 && (
          <div className="records">
            {s.records.map((r) => (
              <div key={r.exercise_id} className="record"><Trophy size={16} /><span>{exName(r)}</span><b>{setText(r.weight, r.reps)}</b></div>
            ))}
          </div>
        )}
        {groups.length > 0 && (
          <div className="sess-sets">
            {groups.map((g) => (
              <div key={g.id} className="ss">
                <span className="ss-name">{g.name}</span>
                <span className="ss-sets">
                  {g.sets.map((x) => (
                    <i key={x.id} className={x.warm ? "warm" : ""}>{setText(x.weight, x.reps, g.kind)}</i>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="stm-label">{t("feel")}</div>
        <Feel value={s.feel} onChange={(v) => { if (v) void patch({ feel: v }); }} />
        <label className="fld">
          <span>{t("note")}</span>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
            onBlur={() => { if (note !== s.note) void patch({ note }); }} />
        </label>
        <div className="modal-foot">
          <button className={"btn danger" + (sure ? " sure" : "")} onClick={remove}>
            <Trash2 size={15} />{sure ? t("delete_sure") : t("delete")}
          </button>
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>{t("close")}</button>
        </div>
      </div>
    </div>
  );
}

export default function History({ version, today, onOpen, onLog }: {
  version: number; today: string; onOpen: (s: Session) => void; onLog: () => void;
}) {
  const [list, setList] = useState<Session[] | null>(null);
  useEffect(() => { api.sessions(120).then(setList).catch(() => setList([])); }, [version]);
  if (!list) return <div className="rv-loading"><span className="spin" /></div>;
  const done = list.filter((s) => s.ended);
  return (
    <>
      <div className="bar">
        <span className="block-n">{done.length ? "" : t("history_empty")}</span>
        <span className="grow" />
        <button className="btn ghost sm" onClick={onLog}><Plus size={15} />{t("log_title")}</button>
      </div>
      <div className="sess-list">
        {done.map((s) => <SessionRow key={s.id} s={s} today={today} onOpen={() => onOpen(s)} />)}
      </div>
    </>
  );
}
