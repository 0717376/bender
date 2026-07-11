import { useState, useEffect, useCallback, useRef } from 'react'
import { FolderTree, FileText, Sparkles } from 'lucide-react'
import type { FileNode } from '../lib/types'
import type { ChatContext } from '../hooks/useWebSocket'
import { fetchTree } from '../lib/api'
import { clearToken } from '../lib/auth'
import { FileTree } from './FileTree'
import { ContentPane, type ContentPaneHandle } from './ContentPane'
import { ChatPane } from './ChatPane'
import styles from './WikiApp.module.css'

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
  const contentRef = useRef<ContentPaneHandle>(null)

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

      <nav className={styles.tabbar}>
        <button data-active={pane === 'tree'} onClick={() => setPane('tree')}>
          <FolderTree size={20} strokeWidth={1.75} />
          <span>Файлы</span>
        </button>
        <button data-active={pane === 'content'} onClick={() => setPane('content')}>
          <FileText size={20} strokeWidth={1.75} />
          <span>Страница</span>
        </button>
        <button data-active={pane === 'chat'} onClick={() => setPane('chat')}>
          <Sparkles size={20} strokeWidth={1.75} />
          <span>Ассистент</span>
        </button>
      </nav>
    </div>
  )
}
