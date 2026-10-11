import { useEffect, useState } from "react";
import { Link2, Moon, MonitorSmartphone, RefreshCw, Sun, Unlink, X } from "lucide-react";
import { api } from "./api";
import { lang, setLang, t, type Lang } from "./i18n";
import type { OuraStatus, Settings } from "./types";

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

/** «5 минут назад» — когда кольцо отдавало данные в последний раз. */
export function ago(unixSec: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now / 1000 - unixSec) / 60));
  if (m < 1) return t("just_now");
  if (m < 60) return t("min_ago", m);
  if (m < 60 * 24) return t("h_ago", Math.round(m / 60));
  return t("d_ago", Math.round(m / 60 / 24));
}

function Oura({ oura, onChange, notify }: { oura: OuraStatus; onChange: (s: OuraStatus) => void; notify: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  if (!oura.configured) return <div className="stm-note">{t("oura_not_configured")}</div>;

  const connect = async () => {
    setBusy(true);
    try {
      // Согласие даётся на сайте Oura: уходим туда целиком, она вернёт обратно в настройки.
      location.href = (await api.ouraConnect()).url;
    } catch (e) {
      notify(String((e as Error).message));
      setBusy(false);
    }
  };
  const sync = async () => {
    setBusy(true);
    await api.ouraSync().then(onChange).catch((e) => notify(String(e.message)));
    setBusy(false);
  };
  const disconnect = async () => {
    if (!sure) return setSure(true);
    await api.ouraDisconnect().then(onChange).catch((e) => notify(String(e.message)));
    setSure(false);
  };

  if (!oura.connected) {
    return (
      <>
        <div className="stm-note">{t(oura.error === "reauth" ? "oura_reauth" : "oura_about")}</div>
        <button className="btn primary" onClick={connect} disabled={busy}><Link2 size={15} />{t("oura_connect")}</button>
      </>
    );
  }
  return (
    <>
      <div className="stm-note">
        {oura.synced ? t("oura_synced", ago(oura.synced)) : t("oura_first_sync")}
        {oura.error === "network" && " · " + t("oura_network")}
      </div>
      <div className="fld-row">
        <button className="btn ghost" onClick={sync} disabled={busy}>
          <RefreshCw size={15} className={busy ? "turning" : ""} />{t("oura_sync")}
        </button>
        <span className="grow" />
        <button className={"btn danger" + (sure ? " sure" : "")} onClick={disconnect}>
          <Unlink size={15} />{sure ? t("oura_disconnect_sure") : t("oura_disconnect")}
        </button>
      </div>
    </>
  );
}

const PROFILE_KEYS = ["goal", "experience", "equipment", "days_per_week", "minutes", "limits", "notes"] as const;

export default function SettingsModal({ mode, palette, oura, onOura, onMode, onPalette, onClose, notify }: {
  mode: ThemeMode; palette: string; oura: OuraStatus | null; onOura: (s: OuraStatus) => void;
  onMode: (m: ThemeMode) => void; onPalette: (p: string) => void; onClose: () => void; notify: (text: string) => void;
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
  const profile = s ? PROFILE_KEYS.filter((k) => s.profile[k] != null && s.profile[k] !== "") : [];

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t("settings")}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("close")}><X size={16} /></button>
        </div>

        <div className="stm-label">{t("oura_title")}</div>
        {oura ? <Oura oura={oura} onChange={onOura} notify={notify} /> : <div className="stm-note">…</div>}
        {s && oura?.connected && (
          <label className="fld inline">
            <span>{t("oura_min")}</span>
            <select value={s.oura_min_minutes} onChange={(e) => patch({ oura_min_minutes: Number(e.target.value) })}>
              {[0, 5, 10, 15, 20, 30].map((m) => <option key={m} value={m}>{m ? `${m} ${t("u_min")}` : t("oura_min_all")}</option>)}
            </select>
          </label>
        )}

        {s && (
          <>
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

            <div className="stm-label">{t("profile")}</div>
            {profile.length === 0 ? <div className="stm-note">{t("profile_empty")}</div> : (
              <dl className="profile">
                {profile.map((k) => <div key={k}><dt>{t(`p_${k}`)}</dt><dd>{String(s.profile[k])}</dd></div>)}
              </dl>
            )}
          </>
        )}

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

        <div className="stm-ver">{t("app_title")} · v{__APP_VERSION__}</div>
      </div>
    </div>
  );
}
