import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, CloudOff, Minus, Plus, Search, Trash2, Trophy, X } from "lucide-react";
import { api } from "./api";
import { clock, dayLabel, exName, kg, mins, num, restText, setText } from "./fmt";
import GuideModal, { GuideThumb } from "./Guide";
import { plural, t } from "./i18n";
import type { Exercise, Record_ } from "./types";
import {
  addItem, addSet, allDone, bump, cursorOf, discard, doneFor, editSet, endedAt, extra, finish, flush, nextSet, onQueue,
  pending, removeSet, rest, serverId, summary, workDone, type DoneSet, type Summary, type WItem, type Workout,
} from "./live";

/** Секундомер: перерисовывает раз в секунду, пока экран открыт. */
function useNow(active = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Экран не гаснет, пока идёт тренировка: телефон лежит на скамье, руки заняты. */
function useWakeLock() {
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request: (k: "screen") => Promise<{ release: () => Promise<void> }> } };
    let lock: { release: () => Promise<void> } | null = null;
    const take = () => {
      if (document.hidden) return;
      nav.wakeLock?.request("screen").then((l) => { lock = l; }).catch(() => {});
    };
    take();
    // Система отбирает блокировку, когда вкладка уходит с экрана, — берём заново при возврате.
    document.addEventListener("visibilitychange", take);
    return () => { document.removeEventListener("visibilitychange", take); void lock?.release().catch(() => {}); };
  }, []);
}

function Stepper({ value, onChange, step, unit, label }: {
  value: number; onChange: (v: number) => void; step: number; unit: string; label: string;
}) {
  const [text, setText_] = useState<string | null>(null);
  const commit = () => {
    if (text == null) return;
    const v = Number(text.replace(",", "."));
    if (Number.isFinite(v) && v >= 0) onChange(v);
    setText_(null);
  };
  return (
    <div className="stp">
      <button type="button" onClick={() => onChange(bump(value, step, -1))} aria-label={label + " −"}><Minus size={18} /></button>
      <label>
        <input inputMode="decimal" aria-label={label} value={text ?? num(value, 2)}
          onFocus={(e) => { setText_(String(value)); requestAnimationFrame(() => e.target.select()); }}
          onChange={(e) => setText_(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        <span>{unit}</span>
      </label>
      <button type="button" onClick={() => onChange(bump(value, step, 1))} aria-label={label + " +"}><Plus size={18} /></button>
    </div>
  );
}

function SetEditor({ item, weight, reps, onWeight, onReps }: {
  item: WItem; weight: number; reps: number; onWeight: (v: number) => void; onReps: (v: number) => void;
}) {
  const time = item.kind === "time";
  return (
    <div className="stp-row">
      <Stepper value={weight} onChange={onWeight} step={item.step} unit={t("u_kg")} label={t("weight")} />
      <Stepper value={reps} onChange={(v) => onReps(Math.max(1, Math.round(v)))} step={time ? 5 : 1}
        unit={time ? t("u_sec") : t("u_reps")} label={time ? t("seconds") : t("reps")} />
    </div>
  );
}

function ExerciseCard({ w, item, open, today, onOpen, onChange }: {
  w: Workout; item: WItem; open: boolean; today: string; onOpen: () => void; onChange: (w: Workout, moved: boolean) => void;
}) {
  const mine = doneFor(w, item.exercise_id);
  const work = mine.filter((d) => !d.warm).length;
  const complete = work >= item.sets;
  const start = useMemo(() => nextSet(w, item), [w, item]);
  const [weight, setWeight] = useState(start.weight);
  const [reps, setReps] = useState(start.reps);
  const [warm, setWarm] = useState(false);
  const [editing, setEditing] = useState<DoneSet | null>(null);
  const [guide, setGuide] = useState(false);
  // После каждого подхода поля возвращаются к цели: вес — как только что, повторы — по плану.
  useEffect(() => { setWeight(start.weight); setReps(start.reps); setWarm(false); }, [mine.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const Hint = item.hint === "up" ? ArrowUp : item.hint === "down" ? ArrowDown : null;
  const target = item.kind === "time"
    ? `${item.sets} × ${item.reps_min}–${item.reps_max} ${t("u_sec")}`
    : `${item.sets} × ${item.reps_min}–${item.reps_max}` + (item.rir ? ` · ${t("rir", item.rir)}` : "");

  if (!open) {
    return (
      <button className={"ex" + (complete ? " done" : "")} onClick={onOpen}>
        <span className="ex-name">{exName(item)}</span>
        <span className="ex-count">{complete ? <Check size={16} strokeWidth={3} /> : `${work}/${item.sets}`}</span>
      </button>
    );
  }

  const add = () => {
    const next = addSet(w, item, weight, reps, warm);
    onChange(next, !warm && workDone(next, item.exercise_id) >= item.sets);
  };

  return (
    <section className="ex open">
      <div className="ex-head">
        <div>
          <h3>{exName(item)}</h3>
          <span className="ex-target">{target} · {t("rest_of", restText(item.rest))}</span>
        </div>
        <GuideThumb id={item.exercise_id} onOpen={() => setGuide(true)} />
      </div>
      {guide && <GuideModal id={item.exercise_id} name={exName(item)} onClose={() => setGuide(false)} />}
      {item.last && item.last.length > 0 ? (
        <div className="ex-last">
          <span>{t("last_time")}{item.last_day ? ` (${dayLabel(item.last_day, today)})` : ""}: </span>
          <b>{item.last.map((s) => setText(s.weight, s.reps, item.kind)).join(", ")}</b>
          {item.hint && item.hint !== "new" && (
            <i className={"hint " + item.hint}>{Hint && <Hint size={12} strokeWidth={2.6} />}{t(`hint_${item.hint}`)}</i>
          )}
        </div>
      ) : <div className="ex-last">{t("hint_new")}</div>}

      {mine.length > 0 && (
        <ol className="sets">
          {mine.map((d, n) => editing?.uid === d.uid ? (
            <li key={d.uid} className="set editing">
              <SetEditor item={item} weight={editing.weight} reps={editing.reps}
                onWeight={(v) => setEditing({ ...editing, weight: v })} onReps={(v) => setEditing({ ...editing, reps: v })} />
              <div className="set-actions">
                <button className="btn danger sm" onClick={() => { onChange(removeSet(w, d.uid), false); setEditing(null); }}>
                  <Trash2 size={14} />{t("delete")}
                </button>
                <span className="grow" />
                <button className="btn ghost sm" onClick={() => setEditing(null)}>{t("cancel")}</button>
                <button className="btn primary sm"
                  onClick={() => { onChange(editSet(w, d.uid, editing.weight, editing.reps), false); setEditing(null); }}>{t("save")}</button>
              </div>
            </li>
          ) : (
            <li key={d.uid} className={"set" + (d.warm ? " warm" : "")}>
              <button onClick={() => setEditing(d)}>
                <span className="set-n">{d.warm ? t("warm_short") : mine.slice(0, n + 1).filter((x) => !x.warm).length}</span>
                <span className="set-v">{item.kind === "time" ? setText(d.weight, d.reps, "time") : `${kg(d.weight)} × ${d.reps}`}</span>
                <Check size={15} strokeWidth={3} />
              </button>
            </li>
          ))}
        </ol>
      )}

      {!editing && (
        <>
          <SetEditor item={item} weight={weight} reps={reps} onWeight={setWeight} onReps={setReps} />
          <div className="ex-foot">
            <label className="check"><input type="checkbox" checked={warm} onChange={(e) => setWarm(e.target.checked)} />{t("warmup")}</label>
            <button className="btn primary big" onClick={add}>
              <Check size={18} strokeWidth={3} />
              {complete ? t("one_more_set") : t("set_done", work + 1, item.sets)}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function RestBar({ w, onChange }: { w: Workout; onChange: (w: Workout) => void }) {
  const now = useNow(w.restUntil != null);
  const buzzed = useRef<number | null>(null);
  const left = w.restUntil != null ? w.restUntil - now : 0;
  useEffect(() => {
    if (w.restUntil == null || left > 0 || buzzed.current === w.restUntil) return;
    buzzed.current = w.restUntil;
    navigator.vibrate?.([180, 90, 180]);
  }, [left, w.restUntil]);
  if (w.restUntil == null) return null;
  // Отдых кончился — полоса висит ещё четверть минуты зелёной и уходит сама.
  if (left < -15000) return null;
  const over = left <= 0;
  return (
    <div className={"restbar" + (over ? " over" : "")}>
      <i style={{ width: over ? "100%" : `${Math.min(100, 100 - (left / (w.restTotal * 1000)) * 100)}%` }} />
      <span className="rest-label">{over ? t("rest_over") : t("rest")}</span>
      <b>{over ? "" : clock(left)}</b>
      {!over && (
        <button onClick={() => onChange(rest(w, w.restUntil! + 30000, w.restTotal + 30))}>+30 {t("u_sec")}</button>
      )}
      <button onClick={() => onChange(rest(w, null))} aria-label={t("skip")}>{over ? <X size={16} /> : t("skip")}</button>
    </div>
  );
}

function Picker({ taken, onPick, onClose }: { taken: Set<number>; onPick: (e: Exercise) => void; onClose: () => void }) {
  const [all, setAll] = useState<Exercise[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => { api.exercises().then(setAll).catch(() => setAll([])); }, []);
  const needle = q.trim().toLowerCase();
  const list = (all ?? []).filter((e) => !taken.has(e.id)
    && (!needle || e.name.toLowerCase().includes(needle) || e.name_en.toLowerCase().includes(needle)));
  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal tall" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t("add_exercise")}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("close")}><X size={16} /></button>
        </div>
        <label className="search">
          <Search size={15} />
          <input autoFocus placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="pick-list scroll">
          {all == null ? <div className="rv-loading"><span className="spin" /></div>
            : list.length === 0 ? <div className="empty">{t("nothing_found")}</div>
            : list.map((e) => (
              <button key={e.id} className="pick" onClick={() => onPick(e)}>
                <span>{exName(e)}</span><i>{t(`m_${e.muscle}` as "m_chest")}</i>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

const FEEL = [1, 2, 3, 4, 5] as const;

function Finish({ w, onDone, onDiscard, onClose }: {
  w: Workout; onDone: (feel: number | null, note: string) => void; onDiscard: () => void; onClose: () => void;
}) {
  const [feel, setFeel] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const empty = w.done.length === 0;
  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t(empty ? "nothing_logged" : "finish_title")}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("close")}><X size={16} /></button>
        </div>
        {empty ? <div className="stm-note">{t("nothing_logged_hint")}</div> : (
          <>
            <div className="stm-label">{t("feel")}</div>
            <div className="feel">
              {FEEL.map((n) => (
                <button key={n} className={feel === n ? "on" : ""} onClick={() => setFeel(feel === n ? null : n)}>
                  <b>{n}</b><span>{t(`feel_${n}`)}</span>
                </button>
              ))}
            </div>
            <label className="fld">
              <span>{t("note")}</span>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("note_ph")} />
            </label>
          </>
        )}
        <div className="modal-foot">
          <button className="btn danger" onClick={onDiscard}><Trash2 size={15} />{t("discard")}</button>
          <span className="grow" />
          {!empty && <button className="btn primary" onClick={() => onDone(feel, note)}>{t("finish")}</button>}
        </div>
      </div>
    </div>
  );
}

function Done({ sum, uid, onClose }: { sum: Summary; uid: string; onClose: () => void }) {
  const [records, setRecords] = useState<Record_[] | null>(null);
  const [waiting, setWaiting] = useState(pending());
  // Рекорды считает сервер: ждём, пока очередь уйдёт, и спрашиваем. Нет связи — итог покажем и без них.
  useEffect(() => {
    let off = false;
    const check = async () => {
      setWaiting(pending());
      const id = serverId(uid);
      if (pending() || id === undefined || off) return;
      const s = await api.session(id).catch(() => null);
      if (!off && s) setRecords(s.records ?? []);
    };
    void flush().then(check);
    const un = onQueue(() => { void check(); });
    return () => { off = true; un(); };
  }, [uid]);
  return (
    <div className="wo-done">
      <div className="wo-done-in">
        <span className="wo-done-ic"><Check size={30} strokeWidth={3} /></span>
        <h1>{t("workout_saved")}</h1>
        <div className="tiles">
          <div className="tile"><b>{mins(sum.minutes)}</b><span>{t("time")}</span></div>
          <div className="tile"><b>{sum.sets}</b><span>{plural(sum.sets, "sets", true)}</span></div>
          <div className="tile"><b>{num(sum.volume / 1000, 1)} {t("u_t")}</b><span>{t("volume")}</span></div>
        </div>
        {records && records.length > 0 && (
          <div className="records">
            {records.map((r) => (
              <div key={r.exercise_id} className="record">
                <Trophy size={16} />
                <span>{exName(r)}</span>
                <b>{kg(r.weight)} × {r.reps}</b>
              </div>
            ))}
          </div>
        )}
        {waiting > 0 && <div className="stm-note"><CloudOff size={14} /> {t("waiting_net")}</div>}
        <button className="btn primary wide" onClick={onClose}>{t("ok")}</button>
      </div>
    </div>
  );
}

export default function WorkoutScreen({ w, today, onChange, onMinimize, onExit }: {
  w: Workout | null; today: string; onChange: (w: Workout | null) => void; onMinimize: () => void; onExit: () => void;
}) {
  useWakeLock();
  const now = useNow();
  const [openIdx, setOpenIdx] = useState(() => (w ? cursorOf(w) : 0));
  const [picker, setPicker] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [done, setDone] = useState<{ sum: Summary; uid: string } | null>(null);
  const [waiting, setWaiting] = useState(pending());
  useEffect(() => onQueue(() => setWaiting(pending())), []);

  if (done) return <Done sum={done.sum} uid={done.uid} onClose={onExit} />;
  if (!w) return null;

  const change = (next: Workout, moved: boolean) => {
    onChange(next);
    // Подходы упражнения сделаны — раскрываем следующее недоделанное.
    if (moved) setOpenIdx(cursorOf(next));
  };

  return (
    <div className="wo">
      <header className="wo-head">
        <button className="icon-btn" onClick={onMinimize} aria-label={t("collapse")}><ChevronDown size={22} /></button>
        <div className="wo-title">
          <b>{w.dayName || t("free_workout")}</b>
          <span>{clock(now - w.startedAt)}{waiting > 0 && <i title={t("waiting_net")}><CloudOff size={12} /></i>}</span>
        </div>
        <button className={"btn sm " + (allDone(w) ? "primary" : "ghost")} onClick={() => setFinishing(true)}>{t("finish")}</button>
      </header>

      <div className="wo-body scroll">
        <div className="wo-in">
          {w.easy && <div className="banner">{t("easy_on")}</div>}
          {w.items.length === 0 && <div className="empty">{t("free_hint")}</div>}
          {w.items.map((item, idx) => (
            <ExerciseCard key={item.exercise_id} w={w} item={item} open={idx === openIdx} today={today}
              onOpen={() => setOpenIdx(idx)} onChange={change} />
          ))}
          <button className="btn ghost wide" onClick={() => setPicker(true)}><Plus size={16} />{t("add_exercise")}</button>
        </div>
      </div>

      <RestBar w={w} onChange={onChange} />

      {picker && (
        <Picker taken={new Set(w.items.map((i) => i.exercise_id))} onClose={() => setPicker(false)}
          onPick={(e) => {
            const next = addItem(w, extra(e));
            onChange(next);
            setOpenIdx(next.items.length - 1);
            setPicker(false);
          }} />
      )}
      {finishing && (
        <Finish w={w} onClose={() => setFinishing(false)}
          onDiscard={() => { discard(w); onChange(null); onExit(); }}
          onDone={(feel, note) => {
            const sum = summary(w, endedAt(w));
            finish(w, feel, note);
            onChange(null);
            setDone({ sum, uid: w.uid });
          }} />
      )}
    </div>
  );
}
