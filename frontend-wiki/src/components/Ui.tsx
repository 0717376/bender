import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TriangleAlert } from 'lucide-react'
import styles from './Ui.module.css'
import { t } from '../lib/i18n'

// Нативные alert/confirm выпадали из оформления и блокировали поток; здесь тот же
// контракт (сообщение и вопрос «да/нет»), но своими компонентами.
export interface ToastAction {
  label: string
  run: () => void
}

interface Ui {
  notify: (text: string, kind?: 'info' | 'error', action?: ToastAction) => void
  ask: (question: string, detail?: string) => Promise<boolean>
}

const UiCtx = createContext<Ui>({ notify: () => {}, ask: async () => false })

export const useUi = (): Ui => useContext(UiCtx)

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
  action?: ToastAction
}

interface Question {
  question: string
  detail?: string
  resolve: (ok: boolean) => void
}

const LIFETIME_MS = 5000

export function UiProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [ask, setAsk] = useState<Question | null>(null)
  const nextId = useRef(1)

  const drop = useCallback((id: number) => {
    setToasts(list => list.filter(x => x.id !== id))
  }, [])

  const notify = useCallback((text: string, kind: 'info' | 'error' = 'info', action?: ToastAction) => {
    const id = nextId.current++
    setToasts(list => [...list, { id, text, kind, action }])
    setTimeout(() => drop(id), LIFETIME_MS)
  }, [drop])

  const askFn = useCallback((question: string, detail?: string) => {
    return new Promise<boolean>(resolve => setAsk({ question, detail, resolve }))
  }, [])

  const close = useCallback((ok: boolean) => {
    setAsk(cur => { cur?.resolve(ok); return null })
  }, [])

  const api = useMemo(() => ({ notify, ask: askFn }), [notify, askFn])

  return (
    <UiCtx.Provider value={api}>
      {children}
      {createPortal(
        <div className={styles.toasts}>
          {toasts.map(x => (
            <div key={x.id} className={styles.toast} data-kind={x.kind}>
              {x.kind === 'error' && <TriangleAlert size={14} strokeWidth={2.2} />}
              <span>{x.text}</span>
              {x.action && (
                <button
                  className={styles.undo}
                  onClick={() => { drop(x.id); x.action!.run() }}
                >
                  {x.action.label}
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
      {ask && createPortal(
        <div className={styles.scrim} onMouseDown={() => close(false)}>
          <div
            className={styles.confirm}
            onMouseDown={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === 'Escape') close(false) }}
          >
            <div className={styles.question}>{ask.question}</div>
            {ask.detail && <div className={styles.detail}>{ask.detail}</div>}
            <div className={styles.buttons}>
              <button onClick={() => close(false)}>{t('cancel')}</button>
              <button className={styles.danger} autoFocus onClick={() => close(true)}>{t('delete')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </UiCtx.Provider>
  )
}
