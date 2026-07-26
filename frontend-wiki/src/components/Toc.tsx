import { useEffect } from 'react'
import type { Heading } from '../lib/markdown'
import styles from './Toc.module.css'
import { t } from '../lib/i18n'

// Меньше трёх заголовков — оглавление только мешает.
export const TOC_MIN = 3

interface TocProps {
  items: Heading[]
  activeId: string
  open: boolean
  onOpen: (open: boolean) => void
  onPick: (id: string) => void
}

// Одно оглавление в трёх состояниях (ширину меряет @container центральной панели):
// колонка справа → штрихи, раскрывающиеся по наведению → выпадающий список на телефоне.
export function Toc({ items, activeId, open, onOpen, onPick }: TocProps) {
  useEffect(() => {
    if (!open) return
    const close = () => onOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open, onOpen])

  if (items.length < TOC_MIN) return null

  return (
    <nav
      className={styles.rail}
      data-open={open ? 'true' : undefined}
      onClick={e => e.stopPropagation()}
      aria-label={t('toc')}
    >
      <button className={styles.ticks} onClick={() => onOpen(!open)} aria-label={t('toc')}>
        {items.map(h => (
          <span key={h.id} data-level={h.level} data-active={h.id === activeId ? 'true' : undefined} />
        ))}
      </button>
      <div className={styles.list}>
        <div className={styles.title}>{t('toc')}</div>
        {items.map(h => (
          <button
            key={h.id}
            data-level={h.level}
            data-active={h.id === activeId ? 'true' : undefined}
            onClick={() => { onPick(h.id); onOpen(false) }}
          >
            {h.text}
          </button>
        ))}
      </div>
    </nav>
  )
}
