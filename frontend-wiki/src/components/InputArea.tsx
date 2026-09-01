import { useRef, useCallback, useState } from 'react'
import { Paperclip, Loader2 } from 'lucide-react'
import { MicButton } from './MicButton'
import { storageUpload } from '../lib/api'
import { useUi } from './Ui'
import styles from './InputArea.module.css'
import { t } from '../lib/i18n'

interface InputAreaProps {
  busy: boolean
  onSend: (text: string) => void
}

// Загрузка через скрепку идёт в inbox — папку, куда уже приземляется всё, что
// пришло боту в Telegram. Один поток входящих, куда бы человек ни ткнул.
const ATTACH_DIR = 'Входящие'

export function InputArea({ busy, onSend }: InputAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const { notify } = useUi()

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

  // Скрепка: файл сначала уходит в /storage/upload?parse=1, ответом приходит
  // готовый parse_prompt со свежим путём внутри контейнера — его и шлём агенту.
  // Скилл-nudge текущей surface (wiki здесь) сам направит агента в правильный
  // навык: положить в вики / создать задачу / просто разобрать.
  const handleAttach = useCallback(async (files: FileList | null) => {
    if (!files?.length || uploading || busy) return
    setUploading(true)
    try {
      for (const f of Array.from(files)) {
        try {
          const r = await storageUpload(ATTACH_DIR, f, { parse: true })
          if (r.parse_prompt) onSend(r.parse_prompt)
        } catch (e) {
          notify(`${f.name}: ${(e as Error).message}`, 'error')
        }
      }
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [uploading, busy, onSend, notify])

  return (
    <div className={styles.footer}>
      <div className={styles.inputRow}>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => handleAttach(e.target.files)}
        />
        <button
          className={styles.attachBtn}
          aria-label={t('attachFile')}
          title={t('attachFile')}
          disabled={busy || uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <Loader2 size={17} className={styles.spin} /> : <Paperclip size={17} />}
        </button>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder={t('askAssistant')}
          rows={1}
          spellCheck={false}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
        />
        <MicButton onTranscription={handleTranscription} />
        <button
          className={styles.sendBtn}
          aria-label={t('send')}
          disabled={busy}
          onClick={handleSubmit}
        >
          &#x2191;
        </button>
      </div>
    </div>
  )
}
