import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'
import styles from './RowMenu.module.css'
import { t } from '../lib/i18n'

export interface MenuItem {
  icon: React.ReactNode
  label: string
  danger?: boolean
  onClick: () => void
}

const MENU_W = 190

// Кнопка «⋯» с выпадающим меню. Меню рендерится порталом с fixed-позицией,
// чтобы не обрезаться скроллящимся деревом.
export function RowMenu({ items, className }: { items: MenuItem[]; className?: string }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (pos) { setPos(null); return }
    const r = btnRef.current!.getBoundingClientRect()
    setPos({
      top: Math.min(r.bottom + 4, window.innerHeight - items.length * 36 - 16),
      left: Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8)),
    })
  }

  useEffect(() => {
    if (!pos) return
    const close = () => setPos(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [pos])

  return (
    <>
      <button
        ref={btnRef}
        className={className}
        data-open={pos ? 'true' : undefined}
        title={t('actions')}
        aria-label={t('actions')}
        draggable
        onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
        onClick={toggle}
      >
        <MoreHorizontal size={15} />
      </button>
      {pos && createPortal(
        <div className={styles.menu} style={{ top: pos.top, left: pos.left, width: MENU_W }} onClick={(e) => e.stopPropagation()}>
          {items.map((it, i) => (
            <button
              key={i}
              className={it.danger ? styles.danger : undefined}
              onClick={() => { setPos(null); it.onClick() }}
            >
              {it.icon} {it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
