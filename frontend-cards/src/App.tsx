import { useCallback, useEffect, useRef, useState } from "react";
import { ChartNoAxesColumn, GalleryVerticalEnd, Layers, Settings, Sparkles, Sun } from "lucide-react";
import { api, getToken, login, subscribeCards, UNAUTHORIZED } from "./api";
import Browse, { type Filter } from "./Browse";
import ChatPane from "./ChatPane";
import DeckModal from "./DeckModal";
import Home from "./Home";
import NoteEditor from "./NoteEditor";
import Review from "./Review";
import SettingsModal, { type ThemeMode } from "./SettingsModal";
import Stats from "./Stats";
import { t } from "./i18n";
import type { Deck, Note, Overview } from "./types";

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

/* Экран живёт в адресе: «назад» на телефоне закрывает сессию повторения, а не приложение. */
export type Route =
  | { page: "home" }
  | { page: "review"; deck?: number }
  | { page: "cards"; filter: Filter }
  | { page: "stats" };

export function parseRoute(hash: string): Route {
  const [page, arg] = hash.replace(/^#\/?/, "").split("/");
  if (page === "review") return { page, deck: Number(arg) || undefined };
  if (page === "cards") return { page, filter: arg === "inbox" || arg === "leech" ? arg : "all" };
  if (page === "stats") return { page };
  return { page: "home" };
}

export function routeHash(r: Route): string {
  if (r.page === "review") return "#/review" + (r.deck ? "/" + r.deck : "");
  if (r.page === "cards") return "#/cards" + (r.filter === "all" ? "" : "/" + r.filter);
  if (r.page === "stats") return "#/stats";
  return "#/";
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, useCallback((r: Route) => { location.hash = routeHash(r); }, [])];
}

/** Сводка для главной и счётчик правок: растёт, когда карточки поменялись где угодно —
    здесь, в боте, у агента. По нему списки перечитывают себя сами. */
function useOverview() {
  const [o, setO] = useState<Overview | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => {
    api.overview().then(setO).catch(() => {});
    setVersion((v) => v + 1);
  }, []);
  useEffect(() => {
    reload();
    const off = subscribeCards(reload);
    // Вкладка могла проспать ночь: граница дня прошла, а событий не было.
    const onShow = () => { if (!document.hidden) reload(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { off(); document.removeEventListener("visibilitychange", onShow); };
  }, [reload]);
  return { o, version, reload };
}

const NAV = [
  { page: "home", label: "nav_today", Icon: Sun },
  { page: "cards", label: "nav_cards", Icon: Layers },
  { page: "stats", label: "nav_stats", Icon: ChartNoAxesColumn },
] as const;

const TITLES = { home: "nav_today", cards: "nav_cards", stats: "nav_stats" } as const;

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

  const [chatCollapsed, setChatCollapsed] = useState(() => {
    const s = localStorage.getItem("cards_chat");
    return s ? s === "0" : true;
  });
  const toggleChat = useCallback(() => setChatCollapsed((c) => {
    localStorage.setItem("cards_chat", c ? "1" : "0");
    return !c;
  }), []);
  // На телефоне чат — шторка поверх экрана: открытой при входе она быть не должна.
  useEffect(() => { if (window.innerWidth <= 860) setChatCollapsed(true); }, []);

  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const s = localStorage.getItem("cards_theme");
    return s === "light" || s === "dark" ? s : "auto";
  });
  const [palette, setPalette] = useState(() => localStorage.getItem("cards_palette") ?? "halo");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = themeMode === "dark" || (themeMode === "auto" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
    };
    apply();
    localStorage.setItem("cards_theme", themeMode);
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [themeMode, palette]);
  useEffect(() => {
    if (palette === "halo") delete document.documentElement.dataset.palette;
    else document.documentElement.dataset.palette = palette;
    localStorage.setItem("cards_palette", palette);
  }, [palette]);

  // Число на иконке установленного приложения — сколько карточек ждёт сегодня.
  const due = o?.due.total ?? 0;
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!o) return;
    (due ? nav.setAppBadge?.(due) : nav.clearAppBadge?.())?.catch(() => {});
  }, [o, due]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deckModal, setDeckModal] = useState<{ deck: Deck | null } | null>(null);
  const [editor, setEditor] = useState<{ note: Note | null; deckId?: number } | null>(null);

  // Карточку правят и посреди сессии: после сохранения сессия перечитывает её.
  const [edited, setEdited] = useState(0);
  const saved = useCallback(() => { reload(); setEdited((n) => n + 1); }, [reload]);
  const editById = useCallback((noteId: number) => {
    api.note(noteId).then((note) => setEditor({ note })).catch(() => {});
  }, []);

  const modals = (
    <>
      {deckModal && <DeckModal deck={deckModal.deck} onClose={() => setDeckModal(null)} onSaved={reload} notify={notify} />}
      {editor && (
        <NoteEditor note={editor.note} deckId={editor.deckId} decks={o?.decks ?? []}
          onClose={() => setEditor(null)} onSaved={saved} notify={notify} />
      )}
      {settingsOpen && (
        <SettingsModal mode={themeMode} palette={palette} due={due}
          onMode={setThemeMode} onPalette={setPalette} onClose={() => setSettingsOpen(false)} />
      )}
      <div className="toasts">{toasts.map((x) => <div key={x.id} className="toast">{x.text}</div>)}</div>
    </>
  );

  if (route.page === "review") {
    return (
      <>
        <Review deck={route.deck} refresh={edited} deckName={o?.decks.find((d) => d.id === route.deck)?.name}
          onExit={() => { reload(); go({ page: "home" }); }} onEdit={editById} />
        {modals}
      </>
    );
  }

  const page = route.page;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo"><GalleryVerticalEnd size={15} strokeWidth={2.4} /></span>
          <span className="word">{t("app_title")}</span>
        </div>
        {NAV.map(({ page: p, label, Icon }) => (
          <button key={p} className={"nav" + (page === p ? " active" : "")}
            onClick={() => go(p === "cards" ? { page: p, filter: "all" } : { page: p })}>
            <span className="ic"><Icon size={16} strokeWidth={2} /></span>
            <span className="lbl">{t(label)}</span>
            {p === "home" && due > 0 && <span className="count">{due}</span>}
            {p === "cards" && (o?.inbox ?? 0) > 0 && <span className="count">{o?.inbox}</span>}
          </button>
        ))}
        <span className="grow" />
        <button className="nav muted" onClick={() => setSettingsOpen(true)}>
          <span className="ic"><Settings size={16} strokeWidth={2} /></span>
          <span className="lbl">{t("settings")}</span>
        </button>
      </aside>

      <main className="pane">
        <div className="pane-scroll scroll">
          <div className="pane-in">
            <header className="pane-head">
              <h1>{t(TITLES[page])}</h1>
              <button className="icon-btn only-mobile" onClick={() => setSettingsOpen(true)} aria-label={t("settings")}>
                <Settings size={19} />
              </button>
            </header>
            {page === "home" && (o
              ? <Home o={o} onReview={(deck) => go({ page: "review", deck })} onDeck={(deck) => setDeckModal({ deck })}
                  onBrowse={(filter) => go({ page: "cards", filter })} onNewDeck={() => setDeckModal({ deck: null })}
                  notify={notify} reload={reload} />
              : <div className="rv-loading"><span className="spin" /></div>)}
            {page === "cards" && (
              <Browse decks={o?.decks ?? []} filter={route.filter} onFilter={(filter) => go({ page: "cards", filter })}
                version={version} onOpen={(note) => setEditor({ note })} onNew={(deckId) => setEditor({ note: null, deckId })} />
            )}
            {page === "stats" && <Stats version={version} />}
          </div>
        </div>
      </main>

      {!chatCollapsed && <div className="chat-scrim" onClick={toggleChat} />}
      <ChatPane onActivity={reload} collapsed={chatCollapsed} onToggle={toggleChat} />

      <nav className="tabbar">
        {NAV.map(({ page: p, label, Icon }) => (
          <button key={p} className={page === p ? "on" : ""}
            onClick={() => go(p === "cards" ? { page: p, filter: "all" } : { page: p })}>
            <Icon size={20} strokeWidth={2} /><span>{t(label)}</span>
            {p === "home" && due > 0 && <i className="tab-dot" />}
          </button>
        ))}
        <button onClick={toggleChat}><Sparkles size={20} strokeWidth={2} /><span>{t("assistant")}</span></button>
      </nav>

      {modals}
    </div>
  );
}
