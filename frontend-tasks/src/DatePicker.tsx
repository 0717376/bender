import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Popover } from "./Popover";
import { MONTHS, WEEKDAYS_SHORT as WD, t } from "./i18n";

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const todayISO = () => new Date().toISOString().slice(0, 10);

type Cell = { y: number; m: number; d: number; out: boolean };

function Calendar({ value, onPick }: { value: string | null; onPick: (iso: string) => void }) {
  const now = new Date();
  const [vy, vm] = value
    ? [Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1]
    : [now.getFullYear(), now.getMonth()];
  const [view, setView] = useState({ y: vy, m: vm });
  const today = todayISO();

  const shift = (delta: number) => {
    const d = new Date(view.y, view.m + delta, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };

  const startWd = (new Date(view.y, view.m, 1).getDay() + 6) % 7; // Mon=0
  const inMonth = new Date(view.y, view.m + 1, 0).getDate();
  const prevDays = new Date(view.y, view.m, 0).getDate();

  const cells: Cell[] = [];
  for (let i = startWd - 1; i >= 0; i--) {
    const d = new Date(view.y, view.m - 1, prevDays - i);
    cells.push({ y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), out: true });
  }
  for (let d = 1; d <= inMonth; d++) cells.push({ y: view.y, m: view.m, d, out: false });
  let nd = 1;
  while (cells.length < 42) {
    const d = new Date(view.y, view.m + 1, nd++);
    cells.push({ y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), out: true });
  }

  return (
    <div className="dp">
      <div className="dp-head">
        <div className="dp-title">{MONTHS[view.m]} {view.y}</div>
        <div className="dp-nav">
          <button onClick={() => shift(-1)} aria-label={t("prev_month")}><ChevronLeft size={16} /></button>
          <button className="dp-today" onClick={() => { const d = new Date(); setView({ y: d.getFullYear(), m: d.getMonth() }); }}>{t("view_today")}</button>
          <button onClick={() => shift(1)} aria-label={t("next_month")}><ChevronRight size={16} /></button>
        </div>
      </div>
      <div className="dp-grid dp-wds">
        {WD.map((w) => <div key={w} className="dp-wd">{w}</div>)}
      </div>
      <div className="dp-grid">
        {cells.map((c, i) => {
          const ci = iso(c.y, c.m, c.d);
          return (
            <button
              key={i}
              className={"dp-day" + (c.out ? " out" : "") + (ci === today ? " today" : "") + (ci === value ? " sel" : "")}
              onClick={() => onPick(ci)}
            >
              {c.d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface QuickAction { key: string; label: string; icon?: ReactNode; danger?: boolean; onClick: () => void; }

/** Floating Halo calendar popover, portaled to <body> so it overlays everything (no clipping). */
export function DatePickerPopover({
  anchor, value, quick, onPick, onClose,
}: {
  anchor: DOMRect;
  value: string | null;
  quick?: QuickAction[];
  onPick: (iso: string) => void;
  onClose: () => void;
}) {
  return (
    <Popover anchor={anchor} className="cal" onClose={onClose}>
      {quick && quick.length > 0 && (
        <div className="d-quick">
          {quick.map((q) => (
            <button key={q.key} className={"qbtn" + (q.danger ? " ghost" : "")} onClick={q.onClick}>
              {q.icon}{q.label}
            </button>
          ))}
        </div>
      )}
      <Calendar value={value} onPick={onPick} />
    </Popover>
  );
}
