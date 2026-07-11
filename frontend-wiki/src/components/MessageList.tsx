import { useRef, forwardRef, useImperativeHandle } from 'react'
import type { ChatMessage } from '../lib/types'
import { Message } from './Message'
import { TypingIndicator } from './TypingIndicator'
import { useAutoScroll } from '../hooks/useAutoScroll'
import styles from './MessageList.module.css'
import msgStyles from './Message.module.css'
import { t } from '../lib/i18n'

interface MessageListProps {
  messages: ChatMessage[]
  waiting: boolean
  streamingRef: React.RefObject<HTMLDivElement | null>
  streamingId: string | null
}

export interface MessageListHandle {
  scrollDown: (smooth?: boolean) => void
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  function MessageList({ messages, waiting, streamingRef, streamingId }, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const scrollDown = useAutoScroll(containerRef)

    useImperativeHandle(ref, () => ({ scrollDown }), [scrollDown])

    const empty = messages.length === 0 && !streamingId && !waiting

    return (
      <div ref={containerRef} className={`${styles.messages} scroll`}>
        <div className={styles.inner}>
          {empty ? (
            <div className={styles.empty}>
              {t('chatHint1')}<br />{t('chatHint2')}
            </div>
          ) : (
            <>
              {messages.map((msg) => (
                <Message key={msg.id} msg={msg} />
              ))}
              {streamingId && (
                <div className={`${msgStyles.message} ${msgStyles.assistant}`}>
                  <div className={msgStyles.role}>{t('roleAssistant')}</div>
                  <div ref={streamingRef} className={msgStyles.content} />
                </div>
              )}
              {waiting && <TypingIndicator />}
            </>
          )}
        </div>
      </div>
    )
  }
)
