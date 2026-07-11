import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Popover } from "./Popover";
import type { RepeatRule } from "./types";

const UNITS: { key: RepeatRule["unit"]; label: string }[] = [
  { key: "day", label: "День" },
  { key: "week", label: "Неделя" },
  { key: "month", label: "Месяц" },
  { key: "year", label: "Год" },
];

// Russian plural forms: [1, 2–4, 5+]
const FORMS: Record<RepeatRule["unit"], [string, string, string]> = {
  day: ["день", "дня", "дней"],
  week: ["неделю", "недели", "недель"],
  month: ["месяц", "месяца", "месяцев"],
  year: ["год", "года", "лет"],
};
const EVERY_ONE: Record<RepeatRule["unit"], string> = {
  day: "каждый день",
  week: "каждую неделю",
  month: "каждый месяц",
  year: "каждый год",
};

function plural(n: number, [one, few, many]: [string, string, string]): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** «каждую неделю», «каждые 3 дня», + «после выполнения» для mode=done. */
export function repeatLabel(r: RepeatRule, short = false): string {
  const base = r.interval === 1 ? EVERY_ONE[r.unit] : `каждые ${r.interval} ${plural(r.interval, FORMS[r.unit])}`;
  return short || r.mode !== "done" ? base : `${base} после выполнения`;
}

export function RepeatPopover({ anchor, value, onSave, onClear, onClose }: {
  anchor: DOMRect;
  value: RepeatRule | null;
  onSave: (r: RepeatRule) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [unit, setUnit] = useState<RepeatRule["unit"]>(value?.unit ?? "week");
  const [interval, setInterval] = useState(value?.interval ?? 1);
  const [mode, setMode] = useState<RepeatRule["mode"]>(value?.mode ?? "schedule");
  const rule: RepeatRule = { unit, interval, mode };

  return (
    <Popover anchor={anchor} className="rep" onClose={onClose}>
      <div className="rep-seg">
        {UNITS.map((u) => (
          <button key={u.key} className={u.key === unit ? "on" : ""} onClick={() => setUnit(u.key)}>{u.label}</button>
        ))}
      </div>

      <div className="rep-row">
        <span className="rep-lbl">Интервал</span>
        <div className="rep-step">
          <button onClick={() => setInterval((v) => Math.max(1, v - 1))} aria-label="Меньше"><Minus size={14} strokeWidth={2.2} /></button>
          <b>{interval}</b>
          <button onClick={() => setInterval((v) => Math.min(365, v + 1))} aria-label="Больше"><Plus size={14} strokeWidth={2.2} /></button>
        </div>
      </div>

      <div className="rep-seg mode">
        <button className={mode === "schedule" ? "on" : ""} onClick={() => setMode("schedule")}>По расписанию</button>
        <button className={mode === "done" ? "on" : ""} onClick={() => setMode("done")}>После выполнения</button>
      </div>

      <div className="rep-preview">{repeatLabel(rule)}</div>

      <div className="rep-foot">
        {value && <button className="qbtn ghost" onClick={onClear}>Убрать</button>}
        <button className="qbtn save" onClick={() => onSave(rule)}>Готово</button>
      </div>
    </Popover>
  );
}
