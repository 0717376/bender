import { useState, useRef, useCallback, useEffect } from 'react'
import { ChevronRight, FileText, Plus, Sparkles } from 'lucide-react'
import type { ChatMessage } from '../lib/types'
import type { ChatContext } from '../hooks/useWebSocket'
import { renderMarkdown } from '../lib/markdown'
import { useWebSocket } from '../hooks/useWebSocket'
import { useTypewriter } from '../hooks/useTypewriter'
import { MessageList, type MessageListHandle } from './MessageList'
import { InputArea } from './InputArea'
import { createToolHtml } from './Message'
import styles from './ChatPane.module.css'
import { t, selectedChars } from '../lib/i18n'

interface ChatPaneProps {
  onAssistantDone: () => void
  onLogout: () => void
  currentPath: string | null
  currentTitle?: string | null
  getContext: () => ChatContext
  pinnedSel: string
  onClearSelection: () => void
  collapsed: boolean
  onToggle: () => void
}

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`
const baseOf = (p: string) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p)

export function ChatPane({ onAssistantDone, onLogout, currentPath, currentTitle, getContext, pinnedSel, onClearSelection, collapsed, onToggle }: ChatPaneProps) {
  // Whether the open page is attached to the context. Re-enabled when you navigate to another page.
  const [pageOff, setPageOff] = useState(false)
  useEffect(() => { setPageOff(false) }, [currentPath])

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [waiting, setWaiting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)

  const streamingRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<MessageListHandle>(null)
  const streamIdRef = useRef<string | null>(null)

  const scrollDown = useCallback(() => listRef.current?.scrollDown(), [])
  const typewriter = useTypewriter(streamingRef, scrollDown)

  const addAssistant = useCallback((md: string) => {
    if (md) setMessages(m => [...m, { id: uid(), role: 'assistant', html: renderMarkdown(md), markdown: md }])
  }, [])

  const flushStream = useCallback(() => {
    if (!streamIdRef.current) return
    const md = typewriter.finish()
    typewriter.reset()
    streamIdRef.current = null
    setStreamingId(null)
    addAssistant(md)
  }, [typewriter, addAssistant])

  const onText = useCallback((id: string, text: string) => {
    setWaiting(false)
    if (streamIdRef.current !== id) {
      flushStream()
      streamIdRef.current = id
      setStreamingId(id)
    }
    typewriter.update(text)
  }, [typewriter, flushStream])

  const onTool = useCallback((name: string, detail: string) => {
    flushStream()
    setMessages(m => [...m, { id: uid(), role: 'tool-use', html: createToolHtml(name, detail) }])
    setWaiting(true)
  }, [flushStream])

  const onError = useCallback((text: string) => {
    flushStream()
    setMessages(m => [...m, { id: uid(), role: 'error', html: text }])
    setWaiting(false)
    setBusy(false)
  }, [flushStream])

  const onDone = useCallback(() => {
    flushStream()
    setWaiting(false)
    setBusy(false)
    onAssistantDone()
  }, [flushStream, onAssistantDone])

  const { send } = useWebSocket(onText, onTool, onError, onDone, onLogout)

  const handleSend = useCallback((text: string) => {
    setMessages(m => [...m, { id: uid(), role: 'user', html: text }])
    setBusy(true)
    setWaiting(true)
    const ctx = getContext()
    send(text, { path: pageOff ? null : ctx.path, selection: ctx.selection }).catch(() => {
      setMessages(m => [...m, { id: uid(), role: 'error', html: t('sendFailed') }])
      setBusy(false)
      setWaiting(false)
    })
    onClearSelection()
  }, [send, getContext, onClearSelection, pageOff])

  if (collapsed) {
    return (
      <button className={styles.rail} onClick={onToggle} aria-label={t('openAssistant')} title={t('openAssistant')}>
        <span className={styles.logo}><Sparkles size={14} strokeWidth={2.4} /></span>
      </button>
    )
  }

  return (
    <div className={styles.pane}>
      <div className={styles.header}>
        <span className={styles.brand}>
          <span className={styles.logo}><Sparkles size={14} strokeWidth={2.4} /></span>
          <span className={styles.title}>{t('assistant')}</span>
        </span>
        <div className={styles.headerActions}>
          <button title={t('clearTitle')} onClick={() => handleSend('/clear')}>{t('clear')}</button>
          <button className={styles.collapseBtn} title={t('collapseChat')} aria-label={t('collapseChat')} onClick={onToggle}>
            <ChevronRight size={16} strokeWidth={2} />
          </button>
        </div>
      </div>
      <MessageList
        ref={listRef}
        messages={messages}
        waiting={waiting}
        streamingRef={streamingRef}
        streamingId={streamingId}
      />
      {currentPath && (
        <div className={styles.context}>
          {pageOff ? (
            <button className={styles.attachBtn} onClick={() => setPageOff(false)}>
              <Plus size={13} /> {t('attachPage')}
            </button>
          ) : (
            <>
              <FileText size={13} />
              <span className={styles.contextPath}>{currentTitle || baseOf(currentPath).replace(/\.md$/, '')}</span>
              <button className={styles.detach} title={t('detachPage')} onClick={() => setPageOff(true)}>×</button>
              {pinnedSel && (
                <span className={styles.contextSel}>
                  {selectedChars(pinnedSel.length)}
                  <button title={t('clearSelection')} onClick={onClearSelection}>×</button>
                </span>
              )}
            </>
          )}
        </div>
      )}
      <InputArea busy={busy} onSend={handleSend} />
    </div>
  )
}
