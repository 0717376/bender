import { useEffect, useState } from "react";
import { BellRing, Moon, MonitorSmartphone, Sun, X } from "lucide-react";
import { api } from "./api";
import { lang, setLang, t, type Lang } from "./i18n";
import type { Settings } from "./types";

export type ThemeMode = "light" | "dark" | "auto";

export const PALETTES: { key: string; name: string; grad: [string, string] }[] = [
  { key: "halo", name: "Halo", grad: ["#D9824F", "#C05A39"] },
  { key: "indigo", name: t("pal_indigo"), grad: ["#7B74F0", "#4F46E5"] },
  { key: "forest", name: t("pal_forest"), grad: ["#55A17E", "#2F7A57"] },
  { key: "ocean", name: t("pal_ocean"), grad: ["#2BA3BE", "#0E7490"] },
  { key: "plum", name: t("pal_plum"), grad: ["#9F82D9", "#7C5CBF"] },
  { key: "amber", name: t("pal_amber"), grad: ["#F59E0B", "#D97706"] },
  { key: "rosewood", name: t("pal_rosewood"), grad: ["#CE8AA0", "#B4637A"] },
  { key: "ink", name: t("pal_ink"), grad: ["#4A4A4A", "#262626"] },
  { key: "matcha", name: t("pal_matcha"), grad: ["#90A472", "#6F8352"] },
  { key: "sky", name: t("pal_sky"), grad: ["#5B9BFF", "#2E7CF6"] },
];

const MODES: { key: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { key: "light", label: t("theme_light"), Icon: Sun },
  { key: "dark", label: t("theme_dark"), Icon: Moon },
  { key: "auto", label: t("theme_auto"), Icon: MonitorSmartphone },
];

const LANGS: { key: Lang; label: string }[] = [
  { key: "ru", label: t("lang_ru") },
  { key: "en", label: t("lang_en") },
];

export default function SettingsModal({ mode, palette, due, onMode, onPalette, onClose }: {
  mode: ThemeMode; palette: string; due: number;
  onMode: (m: ThemeMode) => void; onPalette: (p: string) => void; onClose: () => void;
}) {
  const [s, setS] = useState<Settings | null>(null);

  useEffect(() => { api.settings().then(setS).catch(() => {}); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Правка применяется сразу: отдельной кнопки «сохранить» у настроек нет.
  const patch = (p: Partial<Settings>) => {
    setS((cur) => (cur ? { ...cur, ...p } : cur));
    api.saveSettings(p).then(setS).catch(() => {});
  };

  // iOS показывает число на иконке только после разрешения уведомлений, а системный
  // запрос должен прийти от нажатия в приложении — эта кнопка и есть такое нажатие.
  const [perm, setPerm] = useState<NotificationPermission | null>(
    "Notification" in window ? Notification.permission : null,
  );
  const askBadge = async () => {
    const p = await Notification.requestPermission();
    setPerm(p);
    if (p === "granted" && due > 0) {
      (navigator as Navigator & { setAppBadge?: (n: number) => Promise<void> }).setAppBadge?.(due).catch(() => {});
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t("settings")}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("close")}><X size={16} /></button>
        </div>

        <div className="stm-label">{t("theme")}</div>
        <div className="seg">
          {MODES.map(({ key, label, Icon }) => (
            <button key={key} className={mode === key ? "on" : ""} onClick={() => onMode(key)}>
              <Icon size={14} strokeWidth={2} />{label}
            </button>
          ))}
        </div>

        <div className="stm-label">{t("palette")}</div>
        <div className="pal-grid">
          {PALETTES.map((p) => (
            <button key={p.key} className={"pal-tile" + (palette === p.key ? " on" : "")} onClick={() => onPalette(p.key)}>
              <span className="pal-sw" style={{ background: `linear-gradient(135deg, ${p.grad[0]}, ${p.grad[1]})` }} />
              <span className="pal-nm">{p.name}</span>
            </button>
          ))}
        </div>

        <div className="stm-label">{t("language")}</div>
        <div className="seg">
          {LANGS.map((l) => (
            <button key={l.key} className={lang === l.key ? "on" : ""} onClick={() => setLang(l.key)}>{l.label}</button>
          ))}
        </div>

        {s && (
          <>
            <div className="stm-label">{t("defaults")}</div>
            <div className="fld-row">
              <label className="fld">
                <span>{t("new_per_day")}</span>
                <input type="number" min={0} max={500} value={s.new_per_day}
                  onChange={(e) => patch({ new_per_day: Number(e.target.value) })} />
              </label>
              <label className="fld">
                <span>{t("retention")} · {Math.round(s.retention * 100)}%</span>
                <input type="range" min={70} max={97} value={Math.round(s.retention * 100)}
                  onChange={(e) => patch({ retention: Number(e.target.value) / 100 })} />
              </label>
            </div>

            <div className="stm-label">{t("notify")}</div>
            <div className="fld-row center">
              <label className="check grow">
                <input type="checkbox" checked={s.notify} onChange={(e) => patch({ notify: e.target.checked })} />
                {t("notify_on")}
              </label>
              <label className="fld inline">
                <span>{t("notify_at")}</span>
                <select value={s.notify_hour} disabled={!s.notify} onChange={(e) => patch({ notify_hour: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                </select>
              </label>
            </div>
          </>
        )}

        {perm != null && (
          <>
            <div className="stm-label">{t("badge_title")}</div>
            {perm === "granted" ? <div className="stm-note">{t("badge_on")}</div>
              : perm === "denied" ? <div className="stm-note">{t("badge_denied")}</div>
              : <div className="seg"><button onClick={askBadge}><BellRing size={14} strokeWidth={2} />{t("badge_allow")}</button></div>}
          </>
        )}

        <div className="stm-ver">{t("app_title")} · v{__APP_VERSION__}</div>
      </div>
    </div>
  );
}
