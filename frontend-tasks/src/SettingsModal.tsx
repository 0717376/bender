import { useEffect } from "react";
import { Moon, MonitorSmartphone, Sun, X } from "lucide-react";

export type ThemeMode = "light" | "dark" | "auto";

export const PALETTES: { key: string; name: string; grad: [string, string] }[] = [
  { key: "halo", name: "Halo", grad: ["#D9824F", "#C05A39"] },
  { key: "indigo", name: "Индиго", grad: ["#7B74F0", "#4F46E5"] },
  { key: "forest", name: "Лес", grad: ["#55A17E", "#2F7A57"] },
  { key: "ocean", name: "Океан", grad: ["#2BA3BE", "#0E7490"] },
  { key: "plum", name: "Слива", grad: ["#9F82D9", "#7C5CBF"] },
  { key: "amber", name: "Янтарь", grad: ["#F59E0B", "#D97706"] },
  { key: "rosewood", name: "Роза", grad: ["#CE8AA0", "#B4637A"] },
  { key: "ink", name: "Тушь", grad: ["#4A4A4A", "#262626"] },
  { key: "matcha", name: "Матча", grad: ["#90A472", "#6F8352"] },
  { key: "sky", name: "Небо", grad: ["#5B9BFF", "#2E7CF6"] },
];

const MODES: { key: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { key: "light", label: "Светлая", Icon: Sun },
  { key: "dark", label: "Тёмная", Icon: Moon },
  { key: "auto", label: "Авто", Icon: MonitorSmartphone },
];

export default function SettingsModal({ mode, palette, onMode, onPalette, onClose }: {
  mode: ThemeMode;
  palette: string;
  onMode: (m: ThemeMode) => void;
  onPalette: (p: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="stm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="stm-head">
          <h2>Настройки</h2>
          <button className="stm-x" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
        </div>

        <div className="stm-label">Тема</div>
        <div className="seg">
          {MODES.map(({ key, label, Icon }) => (
            <button key={key} className={mode === key ? "on" : ""} onClick={() => onMode(key)}>
              <Icon size={14} strokeWidth={2} />{label}
            </button>
          ))}
        </div>

        <div className="stm-label">Расцветка</div>
        <div className="pal-grid">
          {PALETTES.map((p) => (
            <button
              key={p.key}
              className={"pal-tile" + (palette === p.key ? " on" : "")}
              onClick={() => onPalette(p.key)}
            >
              <span className="pal-sw" style={{ background: `linear-gradient(135deg, ${p.grad[0]}, ${p.grad[1]})` }} />
              <span className="pal-nm">{p.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
