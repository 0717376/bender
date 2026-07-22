import { useEffect, useState } from "react";
import { BellRing, Check, Copy, Moon, MonitorSmartphone, Sun, X } from "lucide-react";
import { mcpInfo, mcpRotate } from "./api";
import { lang, setLang, t, type Lang } from "./i18n";

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

// Секция «доступ для агентов»: адрес /mcp, токен и готовая команда подключения.
function McpSection() {
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    mcpInfo().then((r) => setToken(r.token)).catch(() => {});
  }, []);

  if (!token) return null;
  const url = window.location.origin + "/mcp";
  const cmd = `claude mcp add --transport http bender ${url} --header "Authorization: Bearer ${token}"`;

  const copy = (text: string, key: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    }).catch(() => {});
  };

  const rotate = () => {
    if (!window.confirm(t("mcp_rotate_confirm"))) return;
    mcpRotate().then((r) => setToken(r.token)).catch(() => {});
  };

  return (
    <>
      <div className="stm-label">{t("mcp_title")}</div>
      <div className="stm-mcp">
        <div className="stm-note">{t("mcp_hint")}</div>
        <div className="stm-mcp-row">
          <span className="stm-mcp-key">{t("mcp_endpoint")}</span>
          <code className="stm-mcp-val">{url}</code>
          <button className="stm-mcp-copy" onClick={() => copy(url, "url")} title={t("copy")}>
            {copied === "url" ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <div className="stm-mcp-row">
          <span className="stm-mcp-key">{t("mcp_token")}</span>
          <code className="stm-mcp-val">{token.slice(0, 8)}…</code>
          <button className="stm-mcp-copy" onClick={() => copy(token, "token")} title={t("copy")}>
            {copied === "token" ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <div className="stm-mcp-btns">
          <button className="stm-mcp-btn" onClick={() => copy(cmd, "cmd")}>
            {copied === "cmd" ? t("copied") : t("mcp_copy_cmd")}
          </button>
          <button className="stm-mcp-ghost" onClick={rotate}>{t("mcp_rotate")}</button>
        </div>
      </div>
    </>
  );
}

export default function SettingsModal({ mode, palette, todayCount, onMode, onPalette, onClose }: {
  mode: ThemeMode;
  palette: string;
  todayCount: number;
  onMode: (m: ThemeMode) => void;
  onPalette: (p: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // iOS shows the icon badge only after notifications are granted, and the system
  // prompt must come from an in-app gesture — this button is that gesture.
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | null>(
    "Notification" in window ? Notification.permission : null,
  );
  const askBadge = async () => {
    const p = await Notification.requestPermission();
    setNotifPerm(p);
    if (p === "granted" && todayCount > 0) {
      (navigator as Navigator & { setAppBadge?: (n: number) => Promise<void> }).setAppBadge?.(todayCount).catch(() => {});
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="stm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="stm-head">
          <h2>{t("settings")}</h2>
          <button className="stm-x" onClick={onClose} aria-label={t("close")}><X size={16} /></button>
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

        <div className="stm-label">{t("language")}</div>
        <div className="seg">
          {LANGS.map((l) => (
            <button key={l.key} className={lang === l.key ? "on" : ""} onClick={() => setLang(l.key)}>
              {l.label}
            </button>
          ))}
        </div>

        {notifPerm != null && (
          <>
            <div className="stm-label">{t("badge_title")}</div>
            {notifPerm === "granted" ? (
              <div className="stm-note">{t("badge_on")}</div>
            ) : notifPerm === "denied" ? (
              <div className="stm-note">{t("badge_denied")}</div>
            ) : (
              <div className="seg">
                <button onClick={askBadge}><BellRing size={14} strokeWidth={2} />{t("badge_allow")}</button>
              </div>
            )}
          </>
        )}

        <McpSection />

        <div className="stm-ver">{t("app_title")} · v{__APP_VERSION__}</div>
      </div>
    </div>
  );
}
