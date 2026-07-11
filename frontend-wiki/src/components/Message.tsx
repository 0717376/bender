import { useRef, useEffect } from 'react'
import type { ChatMessage } from '../lib/types'
import { TOOL_LABELS } from '../lib/types'
import { escapeHtml, enhanceCodeBlocks } from '../lib/markdown'
import styles from './Message.module.css'

interface MessageProps {
  msg: ChatMessage
}

export function Message({ msg }: MessageProps) {
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (msg.role === 'assistant' && contentRef.current) {
      enhanceCodeBlocks(contentRef.current)
    }
  }, [msg.html, msg.role])

  if (msg.role === 'system') {
    return (
      <div className={`${styles.message} ${styles.system}`}>
        <div className={styles.content} dangerouslySetInnerHTML={{ __html: msg.html }} />
      </div>
    )
  }

  if (msg.role === 'tool-use') {
    return (
      <div className={`${styles.message} ${styles.toolUse}`}>
        <div className={styles.content} dangerouslySetInnerHTML={{ __html: msg.html }} />
      </div>
    )
  }

  if (msg.role === 'error') {
    return (
      <div className={`${styles.message} ${styles.error}`}>
        <div className={styles.content}>{msg.html}</div>
      </div>
    )
  }

  const label = msg.role === 'user' ? 'вы' : 'ассистент'

  return (
    <div className={`${styles.message} ${styles[msg.role]}`}>
      <div className={styles.role}>{label}</div>
      {msg.role === 'user' ? (
        <div className={styles.content}>{msg.html}</div>
      ) : (
        <div
          ref={contentRef}
          className={styles.content}
          dangerouslySetInnerHTML={{ __html: msg.html }}
        />
      )}
    </div>
  )
}

export function createToolHtml(name: string, detail: string): string {
  const label = TOOL_LABELS[name] || name
  return `<span class="${styles.toolIcon}"></span><span class="${styles.toolName}">${escapeHtml(label)}</span>${detail ? ` <span class="${styles.toolDetail}">${escapeHtml(detail)}</span>` : ''}`
}
