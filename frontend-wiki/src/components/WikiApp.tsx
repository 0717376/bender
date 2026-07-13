import { useState, useEffect, useCallback, useRef } from 'react'
import { FolderTree, FileText, Sparkles } from 'lucide-react'
import type { FileNode } from '../lib/types'
import type { ChatContext } from '../hooks/useWebSocket'
import { fetchTree } from '../lib/api'
import { clearToken } from '../lib/auth'
import { FileTree } from './FileTree'
import { ContentPane, type ContentPaneHandle } from './ContentPane'
import { ChatPane } from './ChatPane'
import { SettingsModal, type ThemeMode } from './SettingsModal'
import styles from './WikiApp.module.css'
import { t } from '../lib/i18n'

interface WikiAppProps {
  onLogout: () => void
}

type Pane = 'tree' | 'content' | 'chat'

export function WikiApp({ onLogout }: WikiAppProps) {
  const [tree, setTree] = useState<FileNode[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [reloadSignal, setReloadSignal] = useState(0)
  const [selText, setSelText] = useState('')
  // Which pane is visible on mobile (single-pane layout). Ignored on desktop.
  const [pane, setPane] = useState<Pane>('tree')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const s = localStorage.getItem('wiki_theme')
    return s === 'light' || s === 'dark' ? s : 'auto'
  })
  const [palette, setPalette] = useState(() => localStorage.getItem('wiki_palette') ?? 'halo')
  const contentRef = useRef<ContentPaneHandle>(null)

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
  const selectPath = useCallback((p: string | null) => {
    setSelectedPath(p)
    setPane('content')
  }, [])

  const getContext = useCallback((): ChatContext => ({
    path: selectedPath,
    selection: selText,
  }), [selectedPath, selText])

  const clearSelection = useCallback(() => contentRef.current?.clearSelection(), [])

  const reloadTree = useCallback(() => {
    fetchTree().then(setTree).catch(() => {})
  }, [])

  useEffect(() => {
    reloadTree()
  }, [reloadTree])

  const logout = useCallback(() => {
    clearToken()
    onLogout()
  }, [onLogout])

  // After the assistant finishes, files may have changed: refresh tree + open file.
  const onAssistantDone = useCallback(() => {
    reloadTree()
    setReloadSignal(s => s + 1)
  }, [reloadTree])

  return (
    <div className={styles.wrapper} data-pane={pane}>
      <aside className={styles.left}>
        <FileTree
          tree={tree}
          selectedPath={selectedPath}
          onSelect={selectPath}
          onChanged={reloadTree}
          onSettings={() => setSettingsOpen(true)}
        />
      </aside>
      <main className={styles.center}>
        <ContentPane
          ref={contentRef}
          path={selectedPath}
          reloadSignal={reloadSignal}
          onSelectionChange={setSelText}
          onNavigate={selectPath}
        />
      </main>
      <aside className={styles.right}>
        <ChatPane
          onAssistantDone={onAssistantDone}
          onLogout={logout}
          currentPath={selectedPath}
          getContext={getContext}
          pinnedSel={selText}
          onClearSelection={clearSelection}
        />
      </aside>

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
          <span>{t('tabFiles')}</span>
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
