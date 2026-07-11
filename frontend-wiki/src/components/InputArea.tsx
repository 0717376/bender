import { useRef, useCallback } from 'react'
import { MicButton } from './MicButton'
import styles from './InputArea.module.css'

interface InputAreaProps {
  busy: boolean
  onSend: (text: string) => void
}

export function InputArea({ busy, onSend }: InputAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleInput = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [])

  const handleSubmit = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const text = el.value.trim()
    if (!text || busy) return
    onSend(text)
    el.value = ''
    el.style.height = 'auto'
  }, [busy, onSend])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit])

  const handleTranscription = useCallback((text: string) => {
    const el = textareaRef.current
    if (!el) return
    el.value = el.value ? el.value.trimEnd() + ' ' + text : text
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
    el.focus()
  }, [])

  return (
    <div className={styles.footer}>
      <div className={styles.inputRow}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder="Спросите ассистента…"
          rows={1}
          spellCheck={false}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
        />
        <MicButton onTranscription={handleTranscription} />
        <button
          className={styles.sendBtn}
          aria-label="Отправить"
          disabled={busy}
          onClick={handleSubmit}
        >
          &#x2191;
        </button>
      </div>
    </div>
  )
}
