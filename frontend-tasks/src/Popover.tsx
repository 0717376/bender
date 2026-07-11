import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

/** Floating popover portaled to <body> — anchored to a trigger rect, never clipped.
    Closes on outside click, Esc, or any ancestor scroll (avoids drift). */
export function Popover({ anchor, className, onClose, children }: {
  anchor: DOMRect;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, gap = 8, edge = 10;
    let left = Math.min(anchor.left, anchor.right - w);
    left = Math.max(edge, Math.min(left, window.innerWidth - w - edge));
    let top = anchor.top - h - gap;                                 // prefer above
    if (top < edge) top = Math.min(anchor.bottom + gap, window.innerHeight - h - edge);
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    // A mousedown on the trigger itself must NOT close here — the trigger's own
    // onClick toggles the popover; closing first would make it reopen instantly.
    const inAnchor = (e: MouseEvent) =>
      e.clientX >= anchor.left && e.clientX <= anchor.right &&
      e.clientY >= anchor.top && e.clientY <= anchor.bottom;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !inAnchor(e)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose, anchor]);

  return createPortal(
    <div
      ref={ref}
      className={"pop" + (className ? " " + className : "")}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem { value: string | number | null; label: string; dot?: string; }

/** Halo single-select list popover (e.g. project picker). */
export function MenuPopover({ anchor, items, value, onPick, onClose }: {
  anchor: DOMRect;
  items: MenuItem[];
  value: string | number | null;
  onPick: (v: string | number | null) => void;
  onClose: () => void;
}) {
  return (
    <Popover anchor={anchor} className="menu" onClose={onClose}>
      {items.map((it) => (
        <button
          key={String(it.value)}
          className={"menu-item" + (it.value === value ? " sel" : "")}
          onClick={() => onPick(it.value)}
        >
          {it.dot !== undefined
            ? <span className="menu-dot" style={{ background: it.dot }} />
            : <span className="menu-dot hollow" />}
          <span className="menu-lbl">{it.label}</span>
          {it.value === value && <Check size={14} strokeWidth={2.6} className="menu-chk" />}
        </button>
      ))}
    </Popover>
  );
}
