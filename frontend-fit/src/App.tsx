import { useCallback, useEffect, useRef, useState } from "react";
import { ChartNoAxesColumn, Dumbbell, History as HistoryIcon, ListChecks, Settings, Sparkles, Sun } from "lucide-react";
import { api, getToken, login, subscribeFit, UNAUTHORIZED } from "./api";
import ChatPane from "./ChatPane";
import History, { LogModal, SessionModal } from "./History";
import Program from "./Program";
import Progress from "./Progress";
import SettingsModal, { type ThemeMode } from "./SettingsModal";
import Today from "./Today";
import WorkoutScreen from "./Workout";
import { refreshGuides, useBook, warm } from "./guides";
import { t } from "./i18n";
import type { OuraStatus, Overview, PlanDay } from "./types";
import { adopt, begin, current, watchQueue, type Workout } from "./live";

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  useEffect(() => {
    const out = () => setAuthed(false);
    window.addEventListener(UNAUTHORIZED, out);
    return () => window.removeEventListener(UNAUTHORIZED, out);
  }, []);
  if (!authed) return <Auth onOk={() => setAuthed(true)} />;
  return <Shell />;
}

function Auth({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(pw);
      onOk();
    } catch {
      setErr(t("wrong_password"));
    }
  };
  return (
    <div className="auth">
      <form onSubmit={submit}>
        <h1>{t("app_title")}</h1>
        <input type="password" placeholder={t("password")} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {err && <div className="err">{err}</div>}
        <button type="submit">{t("sign_in")}</button>
      </form>
    </div>
  );
}

/* Экран живёт в адресе: «назад» на телефоне сворачивает тренировку, а не закрывает приложение. */
export type Page = "home" | "workout" | "progress" | "history" | "program" | "settings";

export function parseRoute(hash: string): Page {
  const page = hash.replace(/^#\/?/, "").split("/")[0];
  return (["workout", "progress", "history", "program", "settings"] as const).find((p) => p === page) ?? "home";
}

function useRoute(): [Page, (p: Page) => void] {
  const [page, setPage] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setPage(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [page, useCallback((p: Page) => { location.hash = p === "home" ? "#/" : "#/" + p; }, [])];
}

/** Сводка для главной и счётчик правок: растёт, когда дневник поменялся где угодно —
    здесь, у агента, после синхронизации кольца. По нему экраны перечитывают себя сами. */
function useOverview() {
  const [o, setO] = useState<Overview | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => {
    api.overview().then(setO).catch(() => {});
    setVersion((v) => v + 1);
  }, []);
  useEffect(() => {
    reload();
    const off = subscribeFit(reload);
    // Вкладка могла проспать ночь: граница дня прошла, а событий не было.
    const onShow = () => { if (!document.hidden) reload(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { off(); document.removeEventListener("visibilitychange", onShow); };
  }, [reload]);
  return { o, version, reload };
}

const NAV = [
  { page: "home", label: "nav_today", Icon: Sun },
  { page: "progress", label: "nav_progress", Icon: ChartNoAxesColumn },
  { page: "history", label: "nav_history", Icon: HistoryIcon },
  { page: "program", label: "nav_program", Icon: ListChecks },
] as const;

function Shell() {
  const [route, go] = useRoute();
  const { o, version, reload } = useOverview();
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const toastId = useRef(0);
  const notify = useCallback((text: string) => {
    const id = ++toastId.current;
    setToasts((p) => [...p, { id, text }]);
    setTimeout(() => setToasts((p) => p.filter((x) => x.id !== id)), 4000);
  }, []);

  useEffect(() => watchQueue(), []);
  // Техника к упражнениям: справочник — при входе, кадры ближайшего дня — заранее, пока есть сеть.
  const book = useBook();
  useEffect(() => { void refreshGuides(); }, []);
  useEffect(() => warm((o?.next?.items ?? []).map((i) => i.exercise_id)), [book, o?.next]);

  const [chatCollapsed, setChatCollapsed] = useState(() => {
    const s = localStorage.getItem("fit_chat");
    return s ? s === "0" : true;
  });
  const toggleChat = useCallback(() => setChatCollapsed((c) => {
    localStorage.setItem("fit_chat", c ? "1" : "0");
    return !c;
  }), []);
  // На телефоне чат — шторка поверх экрана: открытой при входе она быть не должна.
  useEffect(() => { if (window.innerWidth <= 860) setChatCollapsed(true); }, []);
  const [seed, setSeed] = useState<{ text: string; n: number }>();
  const ask = useCallback((text: string) => {
    setSeed((s) => ({ text, n: (s?.n ?? 0) + 1 }));
    setChatCollapsed(false);
  }, []);

  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const s = localStorage.getItem("fit_theme");
    return s === "light" || s === "dark" ? s : "auto";
  });
  const [palette, setPalette] = useState(() => localStorage.getItem("fit_palette") ?? "halo");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = themeMode === "dark" || (themeMode === "auto" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
    };
    apply();
    localStorage.setItem("fit_theme", themeMode);
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [themeMode, palette]);
  useEffect(() => {
    if (palette === "halo") delete document.documentElement.dataset.palette;
    else document.documentElement.dataset.palette = palette;
    localStorage.setItem("fit_palette", palette);
  }, [palette]);

  const [oura, setOura] = useState<OuraStatus | null>(null);
  useEffect(() => { api.oura().then(setOura).catch(() => {}); }, [version]);

  // Идущая тренировка — в телефоне; сервер знает о ней ровно столько, сколько успело уйти.
  const [local, setLocal] = useState<Workout | null>(() => current());
  const start = useCallback((plan: PlanDay | null) => { setLocal(begin(plan)); go("workout"); }, [go]);
  const resume = useCallback(async () => {
    if (!local && o?.active) {
      // Начата на другом устройстве: собираем её с сервера вместе с целями дня.
      const a = o.active;
      const plan = a.program_day_id ? await api.plan(a.program_day_id, false).catch(() => null) : null;
      setLocal(adopt(a, plan));
    }
    go("workout");
  }, [local, o, go]);

  // Настройки — тоже адрес: после согласия Oura возвращает человека прямо в них.
  const settingsOpen = route === "settings";
  const [logFor, setLogFor] = useState<{ plan: PlanDay | null } | null>(null);
  const [opened, setOpened] = useState<number | null>(null);
  const closeSession = useCallback(() => setOpened(null), []);

  const modals = (
    <>
      {settingsOpen && (
        <SettingsModal mode={themeMode} palette={palette} oura={oura} onOura={(s) => { setOura(s); reload(); }}
          onMode={setThemeMode} onPalette={setPalette} onClose={() => go("home")} notify={notify} />
      )}
      {logFor && o && <LogModal plan={logFor.plan} today={o.day} onClose={() => setLogFor(null)} onSaved={reload} notify={notify} />}
      {opened != null && o && <SessionModal id={opened} today={o.day} onClose={closeSession} onChanged={reload} notify={notify} />}
      <div className="toasts">{toasts.map((x) => <div key={x.id} className="toast">{x.text}</div>)}</div>
    </>
  );

  if (route === "workout") {
    return (
      <>
        <WorkoutScreen w={local} today={o?.day ?? ""} onChange={setLocal}
          onMinimize={() => go("home")} onExit={() => { reload(); go("home"); }} />
        {modals}
      </>
    );
  }

  const page = settingsOpen ? "home" : route;
  const titles = { home: "nav_today", progress: "nav_progress", history: "nav_history", program: "nav_program" } as const;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo"><Dumbbell size={15} strokeWidth={2.4} /></span>
          <span className="word">{t("app_title")}</span>
        </div>
        {NAV.map(({ page: p, label, Icon }) => (
          <button key={p} className={"nav" + (page === p ? " active" : "")} onClick={() => go(p)}>
            <span className="ic"><Icon size={16} strokeWidth={2} /></span>
            <span className="lbl">{t(label)}</span>
          </button>
        ))}
        <span className="grow" />
        <button className="nav muted" onClick={() => go("settings")}>
          <span className="ic"><Settings size={16} strokeWidth={2} /></span>
          <span className="lbl">{t("settings")}</span>
        </button>
      </aside>

      <main className="pane">
        <div className="pane-scroll scroll">
          <div className="pane-in">
            <header className="pane-head">
              <h1>{t(titles[page])}</h1>
              <button className="icon-btn only-mobile" onClick={() => go("settings")} aria-label={t("settings")}>
                <Settings size={19} />
              </button>
            </header>
            {!o ? <div className="rv-loading"><span className="spin" /></div> : (
              <>
                {page === "home" && (
                  <Today o={o} oura={oura} local={local} onStart={start} onResume={resume}
                    onLog={(plan) => setLogFor({ plan })} onAsk={ask} onSettings={() => go("settings")}
                    onOpen={(s) => setOpened(s.id)} reload={reload} notify={notify} />
                )}
                {page === "progress" && <Progress version={version} />}
                {page === "history" && (
                  <History version={version} today={o.day} onOpen={(s) => setOpened(s.id)} onLog={() => setLogFor({ plan: null })} />
                )}
                {page === "program" && <Program version={version} nextId={o.next?.id ?? null} onAsk={ask} />}
              </>
            )}
          </div>
        </div>
      </main>

      {!chatCollapsed && <div className="chat-scrim" onClick={toggleChat} />}
      <ChatPane onActivity={reload} collapsed={chatCollapsed} onToggle={toggleChat} seed={seed} />

      <nav className="tabbar">
        {NAV.map(({ page: p, label, Icon }) => (
          <button key={p} className={page === p ? "on" : ""} onClick={() => go(p)}>
            <Icon size={20} strokeWidth={2} /><span>{t(label)}</span>
          </button>
        ))}
        <button onClick={toggleChat}><Sparkles size={20} strokeWidth={2} /><span>{t("assistant")}</span></button>
      </nav>

      {modals}
    </div>
  );
}
