import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, Eye, List, Pencil } from 'lucide-react'
import { fetchFile, saveFile, storageFileUrl } from '../lib/api'
import {
  renderMarkdown, enhanceCodeBlocks, resolveWikiPath, markLinks, toggleTask,
  collectHeadings, type Heading,
} from '../lib/markdown'
import { hashFor } from '../lib/route'
import { Toc, TOC_MIN } from './Toc'
import styles from './ContentPane.module.css'
import { t, updatedAgo } from '../lib/i18n'

interface ContentPaneProps {
  path: string | null
  title?: string | null
  mtime?: number
  anchor?: string
  exists: (path: string) => boolean
  reloadSignal: number
  onSelectionChange: (text: string) => void
  onNavigate: (path: string, anchor?: string) => void
  onBack: () => void
}

export interface ContentPaneHandle {
  getSelection: () => string
  clearSelection: () => void
}

const HL = 'wiki-sel'
const SAVE_DELAY = 600
// Заголовок считается текущим, когда доходит до этой отметки от верха окна чтения.
const ACTIVE_LINE = 76

export const ContentPane = forwardRef<ContentPaneHandle, ContentPaneProps>(
  function ContentPane(
    { path, title, mtime, anchor, exists, reloadSignal, onSelectionChange, onNavigate, onBack },
    ref,
  ) {
    const [text, setText] = useState('')
    const [loadedPath, setLoadedPath] = useState<string | null>(null)
    const [mode, setMode] = useState<'view' | 'edit'>('view')
    const [dirty, setDirty] = useState(false)
    const [saving, setSaving] = useState(false)
    const [headings, setHeadings] = useState<Heading[]>([])
    const [activeId, setActiveId] = useState('')
    const [tocOpen, setTocOpen] = useState(false)
    const [zoom, setZoom] = useState<string | null>(null)
    const scrollRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<HTMLDivElement>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const pinnedRef = useRef('')

    const textRef = useRef('')
    textRef.current = text
    const dirtyRef = useRef(false)
    dirtyRef.current = dirty
    const saveTimer = useRef<number | undefined>(undefined)
    const wantRef = useRef<string | null>(null)
    const renderedPath = useRef<string | null>(null)

    const clearHighlight = useCallback(() => {
      try { (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete(HL) } catch { /* unsupported */ }
    }, [])

    const clearSelection = useCallback(() => {
      pinnedRef.current = ''
      clearHighlight()
      const sel = window.getSelection()
      if (sel && viewRef.current && sel.anchorNode && viewRef.current.contains(sel.anchorNode)) {
        sel.removeAllRanges()
      }
      onSelectionChange('')
    }, [clearHighlight, onSelectionChange])

    useImperativeHandle(ref, () => ({
      getSelection: () => pinnedRef.current,
      clearSelection,
    }), [clearSelection])

    const doSave = useCallback(async (p: string, content: string) => {
      setSaving(true)
      try {
        await saveFile(p, content)
        if (textRef.current === content) setDirty(false)
      } catch { /* stay dirty, will retry on next change */ }
      finally { setSaving(false) }
    }, [])

    const load = useCallback(async (p: string) => {
      wantRef.current = p
      let content = ''
      try { content = await fetchFile(p) } catch { /* показываем пустую */ }
      if (wantRef.current !== p) return // пока грузили, открыли другую страницу
      setText(content)
      setLoadedPath(p)
      setDirty(false)
    }, [])

    useEffect(() => {
      clearSelection()
      setTocOpen(false)
      if (path) load(path)
      else { setText(''); setLoadedPath(null) }
      setMode('view')
    }, [path, load, clearSelection])

    // Flush unsaved edits when leaving the page or unmounting.
    useEffect(() => {
      return () => {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        if (dirtyRef.current && path) saveFile(path, textRef.current).catch(() => {})
      }
    }, [path])

    useEffect(() => {
      if (reloadSignal && path && !dirtyRef.current) { clearSelection(); load(path) }
    }, [reloadSignal, path, load, clearSelection])

    const onEdit = useCallback((value: string) => {
      setText(value)
      setDirty(true)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (path) saveTimer.current = window.setTimeout(() => doSave(path, value), SAVE_DELAY)
    }, [path, doSave])

    const scrollToId = useCallback((id: string, smooth: boolean): boolean => {
      const sc = scrollRef.current
      const el = viewRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
      if (!sc || !el) return false
      const top = sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 18
      sc.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
      return true
    }, [])

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
    }, [scrollToId])

    const updateActive = useCallback(() => {
      const sc = scrollRef.current
      const doc = viewRef.current
      if (!sc || !doc) return
      const top = sc.getBoundingClientRect().top
      const hs = Array.from(doc.querySelectorAll<HTMLElement>('h2, h3'))
      let cur = ''
      for (const h of hs) {
        if (h.getBoundingClientRect().top - top > ACTIVE_LINE) break
        cur = h.id
      }
      setActiveId(cur || hs[0]?.id || '')
    }, [])

    useEffect(() => {
      const doc = viewRef.current
      if (mode !== 'view' || !doc || loadedPath !== path) return
      doc.innerHTML = renderMarkdown(text)
      enhanceCodeBlocks(doc)
      markLinks(doc, path, exists, t('missingPage'))
      // storage:Папка/скан.jpg → authorized /storage/file URL.
      // marked percent-encodes hrefs; decode before storageFileUrl re-encodes.
      const storagePath = (v: string) => {
        const raw = v.slice('storage:'.length)
        try { return decodeURIComponent(raw) } catch { return raw }
      }
      doc.querySelectorAll<HTMLImageElement>('img[src^="storage:"]').forEach(img => {
        img.src = storageFileUrl(storagePath(img.getAttribute('src')!))
      })
      doc.querySelectorAll<HTMLAnchorElement>('a[href^="storage:"]').forEach(a => {
        a.href = storageFileUrl(storagePath(a.getAttribute('href')!))
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
      })
      doc.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box, i) => {
        box.disabled = false
        box.dataset.task = String(i)
      })
      setHeadings(collectHeadings(doc))
      if (renderedPath.current !== path) {
        renderedPath.current = path
        if (anchor && scrollToId(anchor, false)) reaim(anchor)
        else scrollRef.current!.scrollTop = 0
      }
      updateActive()
    }, [text, mode, path, loadedPath, anchor, exists, scrollToId, reaim, updateActive])

    // Ширина области чтения меняется (свернули чат, повернули экран) — текущий
    // раздел пересчитываем: события скролла при этом не будет.
    useEffect(() => {
      const sc = scrollRef.current
      if (!sc) return
      const ro = new ResizeObserver(() => updateActive())
      ro.observe(sc)
      return () => ro.disconnect()
    }, [mode, updateActive])

    // Переход к разделу той же страницы (ссылка из другой вкладки, кнопка «назад»).
    useEffect(() => {
      if (anchor && mode === 'view') scrollToId(anchor, true)
    }, [anchor, mode, scrollToId])

    useEffect(() => { clearSelection() }, [mode, clearSelection])

    useEffect(() => {
      if (!zoom) return
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null) }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [zoom])

    const flushNow = useCallback(() => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (path && dirtyRef.current) doSave(path, textRef.current)
    }, [path, doSave])

    const captureView = useCallback(() => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      const v = viewRef.current
      if (!v || !v.contains(range.commonAncestorContainer)) return
      const txt = sel.toString()
      if (!txt.trim()) return
      pinnedRef.current = txt
      try {
        const HighlightCtor = (window as unknown as { Highlight?: new (r: Range) => unknown }).Highlight
        const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
        if (HighlightCtor && reg) reg.set(HL, new HighlightCtor(range.cloneRange()))
      } catch { /* unsupported */ }
      onSelectionChange(txt)
    }, [onSelectionChange])

    // Адрес раздела — в строку браузера, но без новой записи в истории.
    const rememberAnchor = useCallback((id: string) => {
      if (path) history.replaceState(null, '', hashFor(path, id))
    }, [path])

    const pickHeading = useCallback((id: string) => {
      scrollToId(id, true)
      rememberAnchor(id)
    }, [scrollToId, rememberAnchor])

    const onViewClick = useCallback((e: React.MouseEvent) => {
      const el = e.target as HTMLElement

      if (el instanceof HTMLInputElement && el.type === 'checkbox' && el.dataset.task) {
        const next = toggleTask(textRef.current, Number(el.dataset.task))
        if (next !== null) onEdit(next)
        return
      }
      if (el instanceof HTMLImageElement && !el.closest('a')) {
        setZoom(el.src)
        return
      }

      // Respect modifier clicks (open in new tab, etc.).
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
      const link = el.closest('a')
      if (!link) return
      if (link.dataset.dead !== undefined) { e.preventDefault(); return }

      const href = link.getAttribute('href') || ''
      if (href.startsWith('#')) {
        e.preventDefault()
        let id = href.slice(1)
        try { id = decodeURIComponent(id) } catch { /* keep raw */ }
        if (scrollToId(id, true)) rememberAnchor(id)
        return
      }
      const target = resolveWikiPath(path, href)
      if (target === null) return // внешняя ссылка: target=_blank уже проставлен
      e.preventDefault()
      if (!target) return
      let frag = href.split('#')[1] || ''
      try { frag = decodeURIComponent(frag) } catch { /* keep raw */ }
      onNavigate(target, frag)
    }, [path, onNavigate, onEdit, scrollToId, rememberAnchor])

    const captureEdit = useCallback(() => {
      const el = textareaRef.current
      if (!el || el.selectionStart === el.selectionEnd) return
      const txt = el.value.slice(el.selectionStart, el.selectionEnd)
      pinnedRef.current = txt
      onSelectionChange(txt)
    }, [onSelectionChange])

    const onKeyDown = (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        flushNow()
      }
    }

    if (!path) {
      return <div className={styles.pane}><div className={styles.empty}>{t('pickPage')}</div></div>
    }

    const segments = path.split('/')
    const leaf = title || segments[segments.length - 1].replace(/\.md$/, '')
    const folders = segments.slice(0, -1)
    const hasToc = mode === 'view' && headings.length >= TOC_MIN

    return (
      <div className={styles.pane}>
        <div className={styles.bar}>
          <button className={styles.backBtn} onClick={onBack} aria-label={t('back')}>
            <ChevronLeft size={19} strokeWidth={2.2} />
          </button>
          <span className={styles.crumbs}>
            {folders.map((f, i) => (
              <span key={i} className={styles.crumb}>{f}<span className={styles.crumbSep}>›</span></span>
            ))}
            <span className={styles.crumbLeaf}>{leaf}</span>
          </span>
          <div className={styles.barActions}>
            {hasToc && (
              <button
                className={styles.tocBtn}
                aria-label={t('toc')}
                onClick={e => { e.stopPropagation(); setTocOpen(o => !o) }}
              >
                <List size={17} strokeWidth={2} />
              </button>
            )}
            {mode === 'edit' ? (
              <span className={styles.status}>{saving || dirty ? t('saving') : t('saved')}</span>
            ) : (
              mtime != null && <span className={styles.meta}>{updatedAgo(mtime)}</span>
            )}
            <button
              className={styles.toggle}
              onClick={() => setMode(m => (m === 'view' ? 'edit' : 'view'))}
            >
              {mode === 'view' ? <><Pencil size={13} /> {t('edit')}</> : <><Eye size={13} /> {t('view')}</>}
            </button>
          </div>
        </div>
        <div className={styles.body}>
          {mode === 'view' ? (
            <div
              ref={scrollRef}
              className={`${styles.view} scroll`}
              onScroll={updateActive}
              onMouseUp={captureView}
              onClick={onViewClick}
            >
              <div ref={viewRef} className={styles.doc} />
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              className={`${styles.editor} scroll`}
              value={text}
              spellCheck={false}
              onChange={e => onEdit(e.target.value)}
              onKeyDown={onKeyDown}
              onSelect={captureEdit}
              onBlur={flushNow}
            />
          )}
          {mode === 'view' && (
            <Toc
              items={headings}
              activeId={activeId}
              open={tocOpen}
              onOpen={setTocOpen}
              onPick={pickHeading}
            />
          )}
        </div>

        {zoom && createPortal(
          <div className={styles.lightbox} onClick={() => setZoom(null)}>
            <img src={zoom} alt="" />
          </div>,
          document.body,
        )}
      </div>
    )
  }
)
