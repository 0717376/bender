import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Popover } from "./Popover";
import { repeatPhrase, t } from "./i18n";
import type { RepeatRule } from "./types";

const UNITS: { key: RepeatRule["unit"]; label: string }[] = [
  { key: "day", label: t("unit_day") },
  { key: "week", label: t("unit_week") },
  { key: "month", label: t("unit_month") },
  { key: "year", label: t("unit_year") },
];

/** "every week", "every 3 days", + "after completion" for mode=done. */
export function repeatLabel(r: RepeatRule, short = false): string {
  return repeatPhrase(r.unit, r.interval, !short && r.mode === "done");
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
        <span className="rep-lbl">{t("interval")}</span>
        <div className="rep-step">
          <button onClick={() => setInterval((v) => Math.max(1, v - 1))} aria-label={t("less")}><Minus size={14} strokeWidth={2.2} /></button>
          <b>{interval}</b>
          <button onClick={() => setInterval((v) => Math.min(365, v + 1))} aria-label={t("more")}><Plus size={14} strokeWidth={2.2} /></button>
        </div>
      </div>

      <div className="rep-seg mode">
        <button className={mode === "schedule" ? "on" : ""} onClick={() => setMode("schedule")}>{t("by_schedule")}</button>
        <button className={mode === "done" ? "on" : ""} onClick={() => setMode("done")}>{t("after_completion")}</button>
      </div>

      <div className="rep-preview">{repeatLabel(rule)}</div>

      <div className="rep-foot">
        {value && <button className="qbtn ghost" onClick={onClear}>{t("remove")}</button>}
        <button className="qbtn save" onClick={() => onSave(rule)}>{t("done_btn")}</button>
      </div>
    </Popover>
  );
}
