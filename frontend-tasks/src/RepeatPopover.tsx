import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { DatePickerPopover } from "./DatePicker";
import { Popover } from "./Popover";
import { nextDates, defaultRule } from "./repeat";
import { MONTHS_SHORT, WEEKDAYS_SHORT, ordinalLabel, repeatPhrase, shortDate, t } from "./i18n";
import type { RepeatRule, RepeatUnit } from "./types";

const UNITS: { key: RepeatUnit; label: string }[] = [
  { key: "day", label: t("unit_day") },
  { key: "week", label: t("unit_week") },
  { key: "month", label: t("unit_month") },
  { key: "year", label: t("unit_year") },
];
const ORDINALS = [1, 2, 3, 4, -1];
const MONTHDAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7];

export function repeatLabel(r: RepeatRule, short = false): string {
  return repeatPhrase(r, short);
}

/** Сегмент-переключатель: один активный вариант из нескольких. */
function Seg<T>({ value, items, onPick, className = "" }: {
  value: T;
  items: { key: T; label: string }[];
  onPick: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={"rep-seg " + className}>
      {items.map((it) => (
        <button key={String(it.key)} className={it.key === value ? "on" : ""} onClick={() => onPick(it.key)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="rep-step">
      <button onClick={() => onChange(Math.max(min, value - 1))} aria-label={t("less")}><Minus size={14} strokeWidth={2.2} /></button>
      <b>{value}</b>
      <button onClick={() => onChange(Math.min(max, value + 1))} aria-label={t("more")}><Plus size={14} strokeWidth={2.2} /></button>
    </div>
  );
}

export function RepeatPopover({ anchor, value, onSave, onClear, onClose }: {
  anchor: DOMRect;
  value: RepeatRule | null;
  onSave: (r: RepeatRule) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [rule, setRule] = useState<RepeatRule>(value?.unit ? value : defaultRule());
  const [datePop, setDatePop] = useState<{ kind: "start" | "end"; anchor: DOMRect } | null>(null);
  const set = (patch: Partial<RepeatRule>) => setRule((r) => ({ ...r, ...patch }));
  const openDate = (kind: "start" | "end") => (ev: React.MouseEvent) =>
    setDatePop({ kind, anchor: (ev.currentTarget as HTMLElement).getBoundingClientRect() });

  // Единица меняет смысл уточнения: у недели дни, у месяца число или «второй вторник».
  const pickUnit = (unit: RepeatUnit) => {
    const fresh = defaultRule(unit);
    setRule((r) => ({ ...fresh, interval: r.interval, mode: r.mode, start: r.start, end: r.end }));
  };

  const toggleWeekday = (d: number) => {
    const cur = rule.weekdays ?? [];
    const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b);
    set({ weekdays: next.length ? next : cur }); // последний день снять нельзя — правило станет пустым
  };

  const byWeekday = !!rule.nth;
  const monthly = rule.unit === "month" || rule.unit === "year";
  const endKind = !rule.end ? "never" : "after" in rule.end ? "after" : "on";
  const upcoming = rule.mode === "done" ? [] : nextDates(rule, 3);

  return (
    <Popover anchor={anchor} className="rep" onClose={onClose}>
      <Seg
        className="mode"
        value={rule.mode}
        items={[{ key: "schedule" as const, label: t("by_schedule") }, { key: "done" as const, label: t("after_completion") }]}
        onPick={(mode) => set({ mode })}
      />

      <div className="rep-row">
        <span className="rep-lbl">{t("interval")}</span>
        <Stepper value={rule.interval} min={1} max={365} onChange={(interval) => set({ interval })} />
      </div>
      <Seg value={rule.unit} items={UNITS} onPick={pickUnit} />

      {rule.unit === "week" && rule.mode === "schedule" && (
        <div className="rep-days">
          {ISO_DAYS.map((d) => (
            <button key={d} className={rule.weekdays?.includes(d) ? "on" : ""} onClick={() => toggleWeekday(d)}>
              {WEEKDAYS_SHORT[d - 1]}
            </button>
          ))}
        </div>
      )}

      {monthly && rule.mode === "schedule" && (
        <>
          {rule.unit === "year" && (
            <div className="rep-months">
              {MONTHS_SHORT.map((name, i) => (
                <button key={name} className={rule.month === i + 1 ? "on" : ""} onClick={() => set({ month: i + 1 })}>
                  {name}
                </button>
              ))}
            </div>
          )}
          <Seg
            value={byWeekday}
            items={[{ key: false, label: t("by_monthday") }, { key: true, label: t("by_weekday") }]}
            onPick={(v) =>
              v
                ? setRule((r) => ({ ...r, monthday: undefined, nth: [1, 1] }))
                : setRule((r) => ({ ...r, nth: undefined, monthday: new Date().getDate() }))
            }
          />
          {byWeekday ? (
            <>
              <div className="rep-days ord">
                {ORDINALS.map((o) => (
                  <button key={o} className={rule.nth?.[0] === o ? "on" : ""} onClick={() => set({ nth: [o, rule.nth?.[1] ?? 1] })}>
                    {ordinalLabel(o)}
                  </button>
                ))}
              </div>
              <div className="rep-days">
                {ISO_DAYS.map((d) => (
                  <button key={d} className={rule.nth?.[1] === d ? "on" : ""} onClick={() => set({ nth: [rule.nth?.[0] ?? 1, d] })}>
                    {WEEKDAYS_SHORT[d - 1]}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="rep-grid">
              {MONTHDAYS.map((d) => (
                <button key={d} className={rule.monthday === d ? "on" : ""} onClick={() => set({ monthday: d })}>{d}</button>
              ))}
              <button className={"wide" + (rule.monthday === "last" ? " on" : "")} onClick={() => set({ monthday: "last" })}>
                {t("last_day")}
              </button>
            </div>
          )}
        </>
      )}

      {rule.mode === "schedule" && (
        <div className="rep-row">
          <span className="rep-lbl">{t("starts")}</span>
          <button className="rep-date" onClick={openDate("start")}>{shortDate(rule.start ?? "")}</button>
        </div>
      )}

      <div className="rep-row">
        <span className="rep-lbl">{t("ends")}</span>
        <Seg
          className="tiny"
          value={endKind}
          items={[
            { key: "never" as const, label: t("end_never") },
            { key: "after" as const, label: t("end_after") },
            { key: "on" as const, label: t("end_on") },
          ]}
          onPick={(k) =>
            set({ end: k === "never" ? undefined : k === "after" ? { after: 10 } : { on: nextDates(rule, 1)[0] ?? rule.start } })
          }
        />
      </div>
      {rule.end && "after" in rule.end && (
        <div className="rep-row">
          <span className="rep-lbl">{t("times_short")}</span>
          <Stepper value={rule.end.after} min={1} max={999} onChange={(after) => set({ end: { after } })} />
        </div>
      )}
      {rule.end && "on" in rule.end && (
        <div className="rep-row">
          <span className="rep-lbl">{t("end_on")}</span>
          <button className="rep-date" onClick={openDate("end")}>{shortDate(rule.end.on)}</button>
        </div>
      )}

      <div className="rep-preview">
        {repeatLabel(rule)}
        {upcoming.length > 0 && <span className="rep-next">{t("next_up")}: {upcoming.map(shortDate).join(", ")}</span>}
      </div>

      <div className="rep-foot">
        {value?.unit && <button className="qbtn ghost" onClick={onClear}>{t("remove")}</button>}
        <button className="qbtn save" onClick={() => onSave(rule)}>{t("done_btn")}</button>
      </div>

      {datePop && (
        <DatePickerPopover
          anchor={datePop.anchor}
          value={datePop.kind === "start" ? rule.start ?? null : (rule.end && "on" in rule.end ? rule.end.on : null)}
          onPick={(d) => {
            if (datePop.kind === "start") set({ start: d });
            else set({ end: { on: d } });
            setDatePop(null);
          }}
          onClose={() => setDatePop(null)}
        />
      )}
    </Popover>
  );
}
