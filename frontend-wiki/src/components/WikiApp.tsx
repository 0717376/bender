import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { FolderTree, FileText, Sparkles, BookOpen, HardDrive, TriangleAlert } from 'lucide-react'
import type { FileNode } from '../lib/types'
import type { ChatContext } from '../hooks/useWebSocket'
import { fetchTree, storageTree, subscribeFiles } from '../lib/api'
import { parseHash, hashFor } from '../lib/route'
import { clearToken } from '../lib/auth'
import { FileTree } from './FileTree'
import { StorageTree } from './StorageTree'
import { StorageView } from './StorageView'
import { ContentPane, type ContentPaneHandle } from './ContentPane'
import { ChatPane } from './ChatPane'
import { SearchPalette } from './SearchPalette'
import { SettingsModal, type ThemeMode } from './SettingsModal'
import styles from './WikiApp.module.css'
import { t } from '../lib/i18n'

interface WikiAppProps {
  onLogout: () => void
}

type Pane = 'tree' | 'content' | 'chat'
type Section = 'wiki' | 'files'

function collectPaths(nodes: FileNode[], into: Set<string>): Set<string> {
  for (const n of nodes) {
    into.add(n.path)
    if (n.children) collectPaths(n.children, into)
  }
  return into
}

function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.children && path.startsWith(n.path + '/')) {
      const hit = findNode(n.children, path)
      if (hit) return hit
    }
  }
  return null
}

export function WikiApp({ onLogout }: WikiAppProps) {
  // null — дерево ещё не загружено; пустой массив — вики действительно пуста.
  const [tree, setTree] = useState<FileNode[] | null>(null)
  const [treeError, setTreeError] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [anchor, setAnchor] = useState('')
  const [section, setSection] = useState<Section>('wiki')
  const [storage, setStorage] = useState<FileNode[]>([])
  const [storagePath, setStoragePath] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [selText, setSelText] = useState('')
  // Which pane is visible on mobile (single-pane layout). Ignored on desktop.
  const [pane, setPane] = useState<Pane>('tree')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const s = localStorage.getItem('wiki_theme')
    return s === 'light' || s === 'dark' ? s : 'auto'
  })
  const [palette, setPalette] = useState(() => localStorage.getItem('wiki_palette') ?? 'halo')
  const [chatCollapsed, setChatCollapsed] = useState(() => localStorage.getItem('wiki_chat') === 'collapsed')
  // На узких экранах чат живёт в таб-баре — сворачивание в рейку только для десктопа.
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const contentRef = useRef<ContentPaneHandle>(null)
  const openPathRef = useRef<string | null>(null)
  openPathRef.current = selectedPath

  const nodes = tree ?? []

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)')
    const apply = () => setNarrow(mq.matches)
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  const toggleChat = useCallback(() => {
    setChatCollapsed(c => {
      localStorage.setItem('wiki_chat', c ? 'open' : 'collapsed')
      return !c
    })
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = themeMode === 'dark' || (themeMode === 'auto' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    localStorage.setItem('wiki_theme', themeMode)
    mq.addEventListener('change', apply) // follow the OS while in auto
    return () => mq.removeEventListener('change', apply)
  }, [themeMode])

  useEffect(() => {
    if (palette === 'halo') delete document.documentElement.dataset.palette
    else document.documentElement.dataset.palette = palette
    localStorage.setItem('wiki_palette', palette)
  }, [palette])

  // Tapping a file in the tree opens it and slides to the content pane on mobile.
  // Путь открытой страницы держим в адресе: перезагрузка и «назад» работают.
  const selectPath = useCallback((p: string | null, to = '') => {
    setSelectedPath(p)
    setAnchor(to)
    setPane('content')
    const cur = parseHash()
    if (!p) {
      if (cur.path) history.replaceState(null, '', location.pathname + location.search)
    } else if (cur.path !== p || cur.anchor !== to) {
      location.hash = hashFor(p, to)
    }
  }, [])

  useEffect(() => {
    const apply = () => {
      const { path, anchor: to } = parseHash()
      if (!path) return
      setSection('wiki')
      setSelectedPath(path)
      setAnchor(to)
      setPane('content')
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [])

  const pages = useMemo(() => (tree ? collectPaths(tree, new Set<string>()) : null), [tree])

  const getContext = useCallback((): ChatContext => ({
    path: selectedPath,
    selection: selText,
  }), [selectedPath, selText])

  const clearSelection = useCallback(() => contentRef.current?.clearSelection(), [])

  const reloadTree = useCallback(async () => {
    try {
      setTree(await fetchTree())
      setTreeError(false)
    } catch {
      setTreeError(true)
    }
  }, [])

  const reloadStorage = useCallback(() => {
    storageTree().then(setStorage).catch(() => {})
  }, [])

  useEffect(() => {
    reloadTree()
    reloadStorage()
  }, [reloadTree, reloadStorage])

  // Живая синхронизация: страницы меняют агент, Telegram, крон и внешние агенты по MCP —
  // всё это мимо этой вкладки. Бэкенд следит за файлами и присылает, что изменилось.
  useEffect(() => {
    return subscribeFiles(ev => {
      if (ev.pages.length) {
        reloadTree()
        const open = openPathRef.current
        if (open && ev.pages.includes(open)) contentRef.current?.reload()
      }
      if (ev.storage) reloadStorage()
    })
  }, [reloadTree, reloadStorage])

  // Подстраховка на случай, когда поток простоял мёртвым (ноутбук спал, сеть отваливалась).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      reloadTree()
      reloadStorage()
      contentRef.current?.reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [reloadTree, reloadStorage])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const storageMissing = useCallback(() => {
    reloadStorage()
  }, [reloadStorage])

  // Папка открывает обзор в центре, не дёргая мобильную панель; файл — превью.
  const selectStorage = useCallback((p: string | null) => {
    setStoragePath(p || null)
    if (p && findNode(storage, p)?.type === 'file') setPane('content')
  }, [storage])

  const logout = useCallback(() => {
    clearToken()
    onLogout()
  }, [onLogout])

  // Свои правки видно сразу, не дожидаясь следующего обхода файлов на бэкенде.
  const onAssistantDone = useCallback(() => {
    reloadTree()
    reloadStorage()
    contentRef.current?.reload()
  }, [reloadTree, reloadStorage])

  const sections = (
    <div className={styles.sections}>
      <button data-active={section === 'wiki'} onClick={() => setSection('wiki')}>
        <BookOpen size={13} strokeWidth={2.2} /> {t('wiki')}
      </button>
      <button data-active={section === 'files'} onClick={() => setSection('files')}>
        <HardDrive size={13} strokeWidth={2.2} /> {t('storage')}
      </button>
    </div>
  )

  return (
    <div className={styles.wrapper} data-pane={pane}>
      <aside className={styles.left}>
        {section === 'wiki' ? (
          <>
            {treeError && (
              <button className={styles.treeError} onClick={reloadTree}>
                <TriangleAlert size={14} strokeWidth={2.2} />
                <span>{t('treeFailed')}</span>
                <span className={styles.retry}>{t('retry')}</span>
              </button>
            )}
            <FileTree
              tree={nodes}
              selectedPath={selectedPath}
              onSelect={selectPath}
              onChanged={reloadTree}
              onSettings={() => setSettingsOpen(true)}
              onSearch={() => setSearchOpen(true)}
              header={sections}
            />
          </>
        ) : (
          <StorageTree
            tree={storage}
            selectedPath={storagePath}
            onSelect={selectStorage}
            onChanged={reloadStorage}
            onSettings={() => setSettingsOpen(true)}
            header={sections}
          />
        )}
      </aside>
      <main className={styles.center}>
        {section === 'wiki' ? (
          <ContentPane
            ref={contentRef}
            path={selectedPath}
            title={selectedPath ? findNode(nodes, selectedPath)?.title : undefined}
            mtime={selectedPath ? findNode(nodes, selectedPath)?.mtime : undefined}
            anchor={anchor}
            pages={pages}
            onSelectionChange={setSelText}
            onNavigate={selectPath}
            onBack={() => setPane('tree')}
          />
        ) : (
          <StorageView
            path={storagePath}
            node={storagePath ? findNode(storage, storagePath) : null}
            entries={storagePath
              ? findNode(storage, storagePath)?.children ?? []
              : storage}
            onSelect={selectStorage}
            onChanged={reloadStorage}
            onMissing={storageMissing}
            onBack={() => setPane('tree')}
          />
        )}
      </main>
      <aside className={`${styles.right} ${chatCollapsed && !narrow ? styles.rightCollapsed : ''}`}>
        <ChatPane
          onAssistantDone={onAssistantDone}
          onLogout={logout}
          currentPath={selectedPath}
          currentTitle={selectedPath ? findNode(nodes, selectedPath)?.title : undefined}
          getContext={getContext}
          pinnedSel={selText}
          onClearSelection={clearSelection}
          collapsed={chatCollapsed && !narrow}
          onToggle={toggleChat}
        />
      </aside>

      {searchOpen && (
        <SearchPalette
          onPick={p => { setSearchOpen(false); setSection('wiki'); selectPath(p) }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          mode={themeMode}
          palette={palette}
          onMode={setThemeMode}
          onPalette={setPalette}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <nav className={styles.tabbar}>
        <button data-active={pane === 'tree'} onClick={() => setPane('tree')}>
          <FolderTree size={20} strokeWidth={1.75} />
          <span>{section === 'wiki' ? t('wiki') : t('storage')}</span>
        </button>
        <button data-active={pane === 'content'} onClick={() => setPane('content')}>
          <FileText size={20} strokeWidth={1.75} />
          <span>{t('tabPage')}</span>
        </button>
        <button data-active={pane === 'chat'} onClick={() => setPane('chat')}>
          <Sparkles size={20} strokeWidth={1.75} />
          <span>{t('assistant')}</span>
        </button>
      </nav>
    </div>
  )
}
