import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { searchPages, type SearchHit } from '../lib/api'
import styles from './SearchPalette.module.css'
import { t } from '../lib/i18n'

interface Props {
  onPick: (path: string) => void
  onClose: () => void
}

export function SearchPalette({ onPick, onClose }: Props) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    if (!q.trim()) { setHits([]); return }
    const h = setTimeout(() => {
      searchPages(q).then(r => { setHits(r); setActive(0) }).catch(() => setHits([]))
    }, 140)
    return () => clearTimeout(h)
  }, [q])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return onClose()
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    if (e.key === 'Enter' && hits[active]) { e.preventDefault(); onPick(hits[active].path) }
  }

  return (
    <div className={styles.scrim} onMouseDown={onClose}>
      <div className={styles.palette} onMouseDown={e => e.stopPropagation()}>
        <div className={styles.input}>
          <Search size={17} strokeWidth={2} />
          <input
            ref={inputRef}
            placeholder={t('searchHint')}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
        {hits.length > 0 && (
          <ul className={styles.results}>
            {hits.map((h, i) => (
              <li
                key={h.path}
                data-active={i === active ? 'true' : undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(h.path)}
              >
                <span className={styles.title}>{h.title}</span>
                <span className={styles.path}>{h.path}</span>
                {h.snippet && <span className={styles.snippet}>{h.snippet}</span>}
              </li>
            ))}
          </ul>
        )}
        {q.trim() && hits.length === 0 && <div className={styles.empty}>{t('nothingFound')}</div>}
      </div>
    </div>
  )
}
