import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { api } from "./api";
import type { Task } from "./types";

export default function CommandPalette({ onPick, onClose }: { onPick: (t: Task) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Task[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const h = setTimeout(() => {
      api.search(q).then((r) => { setResults(r); setActive(0); }).catch(() => setResults([]));
    }, 140);
    return () => clearTimeout(h);
  }, [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === "Enter" && results[active]) { e.preventDefault(); onPick(results[active]); }
  };

  return (
    <div className="palette-scrim" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={17} strokeWidth={2} />
          <input
            ref={inputRef}
            placeholder="Поиск задач…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
        {results.length > 0 && (
          <ul className="palette-results">
            {results.map((t, i) => (
              <li
                key={t.id}
                className={(i === active ? "active " : "") + (t.status === "completed" ? "done" : "")}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(t)}
              >
                <span className="pr-title">{t.title}</span>
                {t.when_date && <span className="pr-meta">{t.when_date}</span>}
              </li>
            ))}
          </ul>
        )}
        {q.trim() && results.length === 0 && <div className="palette-empty">Ничего не найдено</div>}
      </div>
    </div>
  );
}
