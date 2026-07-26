import { useCallback, useEffect, useRef, useState } from 'react'
import { collectHeadings, type Heading } from '../lib/markdown'

// Заголовок считается текущим, когда доходит до этой отметки от верха окна чтения.
const ACTIVE_LINE = 76

export interface Toc {
  headings: Heading[]
  activeId: string
  /** Пересобрать список после перерисовки документа. */
  refresh: () => void
  updateActive: () => void
  scrollToId: (id: string, smooth: boolean) => boolean
  /** Повторно прицелиться после подгрузки шрифта (см. ниже). */
  reaim: (id: string) => void
}

/** Оглавление документа: заголовки, текущий раздел, прокрутка к якорю. */
export function useToc(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  docRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
): Toc {
  const [headings, setHeadings] = useState<Heading[]>([])
  const [activeId, setActiveId] = useState('')
  const activeRef = useRef('')

  const scrollToId = useCallback((id: string, smooth: boolean): boolean => {
    const sc = scrollRef.current
    const el = docRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
    if (!sc || !el) return false
    const top = sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 18
    sc.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
    return true
  }, [scrollRef, docRef])

  // Manrope приезжает с Google Fonts уже после первого рендера (display=swap) и
  // сдвигает вёрстку — повторяем прицел, пока пользователь сам не начал листать.
  const reaim = useCallback((id: string) => {
    const sc = scrollRef.current
    if (!sc) return
    let at = sc.scrollTop
    const again = () => {
      if (!scrollRef.current || Math.abs(scrollRef.current.scrollTop - at) > 2) return
      scrollToId(id, false)
      at = scrollRef.current.scrollTop
    }
    requestAnimationFrame(again)
    document.fonts?.ready.then(again).catch(() => {})
  }, [scrollRef, scrollToId])

  const updateActive = useCallback(() => {
    const sc = scrollRef.current
    const doc = docRef.current
    if (!sc || !doc) return
    const top = sc.getBoundingClientRect().top
    const hs = Array.from(doc.querySelectorAll<HTMLElement>('h2, h3'))
    let cur = ''
    for (const h of hs) {
      if (h.getBoundingClientRect().top - top > ACTIVE_LINE) break
      cur = h.id
    }
    const next = cur || hs[0]?.id || ''
    if (next === activeRef.current) return
    activeRef.current = next
    setActiveId(next)
  }, [scrollRef, docRef])

  const refresh = useCallback(() => {
    const doc = docRef.current
    setHeadings(doc ? collectHeadings(doc) : [])
  }, [docRef])

  // Ширина области чтения меняется (свернули чат, повернули экран) — текущий
  // раздел пересчитываем: события скролла при этом не будет.
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc || !enabled) return
    const ro = new ResizeObserver(() => updateActive())
    ro.observe(sc)
    return () => ro.disconnect()
  }, [scrollRef, enabled, updateActive])

  return { headings, activeId, refresh, updateActive, scrollToId, reaim }
}
