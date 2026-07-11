import { useRef, useCallback } from 'react'
import { renderMarkdown } from '../lib/markdown'

interface TypewriterState {
  targetText: string
  revealedLen: number
  raf: number
  done: boolean
}

export function useTypewriter(
  contentRef: React.RefObject<HTMLDivElement | null>,
  scrollDown: () => void,
) {
  const stateRef = useRef<TypewriterState>({
    targetText: '',
    revealedLen: 0,
    raf: 0,
    done: false,
  })

  const tick = useCallback(() => {
    const s = stateRef.current
    s.raf = 0
    if (s.done) return

    const remaining = s.targetText.length - s.revealedLen
    if (remaining <= 0) return

    const speed = remaining > 500 ? 60
      : remaining > 200 ? 30
        : remaining > 80 ? 12
          : remaining > 20 ? 5
            : 2

    s.revealedLen = Math.min(s.revealedLen + speed, s.targetText.length)
    const partial = s.targetText.slice(0, s.revealedLen)

    if (contentRef.current) {
      contentRef.current.innerHTML = renderMarkdown(partial)

      const cursor = document.createElement('span')
      cursor.className = 'tw-cursor'
      const lastBlock = contentRef.current.querySelector(':scope > :last-child')
      ;(lastBlock || contentRef.current).appendChild(cursor)
    }

    scrollDown()

    if (s.revealedLen < s.targetText.length) {
      s.raf = requestAnimationFrame(tick)
    }
  }, [contentRef, scrollDown])

  const update = useCallback((text: string) => {
    const s = stateRef.current
    s.done = false
    s.targetText = text
    if (!s.raf) {
      s.raf = requestAnimationFrame(tick)
    }
  }, [tick])

  const finish = useCallback((): string => {
    const s = stateRef.current
    s.done = true
    if (s.raf) {
      cancelAnimationFrame(s.raf)
      s.raf = 0
    }
    if (s.targetText && contentRef.current) {
      contentRef.current.innerHTML = renderMarkdown(s.targetText)
    }
    return s.targetText
  }, [contentRef])

  const reset = useCallback(() => {
    const s = stateRef.current
    if (s.raf) cancelAnimationFrame(s.raf)
    stateRef.current = { targetText: '', revealedLen: 0, raf: 0, done: false }
  }, [])

  return { update, finish, reset }
}
