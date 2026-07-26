import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, Eye, List, Pencil, TriangleAlert } from 'lucide-react'
import { storageFileUrl } from '../lib/api'
import {
  renderMarkdown, enhanceCodeBlocks, resolveWikiPath, markLinks, toggleTask,
} from '../lib/markdown'
import { hashFor } from '../lib/route'
import { usePage } from '../hooks/usePage'
import { useToc } from '../hooks/useToc'
import { Toc, TOC_MIN } from './Toc'
import styles from './ContentPane.module.css'
import { t, updatedAgo } from '../lib/i18n'

interface ContentPaneProps {
  path: string | null
  title?: string | null
  mtime?: number
  anchor?: string
  /** Пути всех страниц вики; null — дерево ещё не загружено (ссылки не судим). */
  pages: Set<string> | null
  onSelectionChange: (text: string) => void
  onNavigate: (path: string, anchor?: string) => void
  onBack: () => void
}

export interface ContentPaneHandle {
  getSelection: () => string
  clearSelection: () => void
  reload: () => void
}

const HL = 'wiki-sel'

export const ContentPane = forwardRef<ContentPaneHandle, ContentPaneProps>(
  function ContentPane(
    { path, title, mtime, anchor, pages, onSelectionChange, onNavigate, onBack },
    ref,
  ) {
    const page = usePage(path)
    const { edit } = page
    const [mode, setMode] = useState<'view' | 'edit'>('view')
    const [tocOpen, setTocOpen] = useState(false)
    const [zoom, setZoom] = useState<string | null>(null)
    const scrollRef = useRef<HTMLDivElement>(null)
    const docRef = useRef<HTMLDivElement>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const pinnedRef = useRef('')
    const renderedPath = useRef<string | null>(null)

    // Разбираем на отдельные функции: все они стабильны, а объект пересоздаётся
    // каждый рендер — в зависимостях эффектов ему делать нечего.
    const { headings, activeId, refresh, updateActive, scrollToId, reaim } = useToc(
      scrollRef, docRef, mode === 'view',
    )

    const textRef = useRef('')
    textRef.current = page.text

    const clearSelection = useCallback(() => {
      pinnedRef.current = ''
      try { (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete(HL) } catch { /* unsupported */ }
      const sel = window.getSelection()
      if (sel && docRef.current && sel.anchorNode && docRef.current.contains(sel.anchorNode)) {
        sel.removeAllRanges()
      }
      onSelectionChange('')
    }, [onSelectionChange])

    useImperativeHandle(ref, () => ({
      getSelection: () => pinnedRef.current,
      clearSelection,
      reload: page.reload,
    }), [clearSelection, page.reload])

    useEffect(() => {
      clearSelection()
      setTocOpen(false)
      setMode('view')
    }, [path, clearSelection])

    useEffect(() => { clearSelection() }, [mode, clearSelection])

    // Перерисовка документа. Дерево страниц сюда намеренно не входит: иначе каждое
    // обновление дерева стирало бы innerHTML вместе с выделением и подсветкой кода.
    useEffect(() => {
      const doc = docRef.current
      if (mode !== 'view' || !doc || page.loadedPath !== path) return
      doc.innerHTML = renderMarkdown(page.text)
      enhanceCodeBlocks(doc)
      // storage:Папка/скан.jpg → авторизованный /storage/file URL.
      // marked процентно кодирует href; декодируем до того, как storageFileUrl закодирует снова.
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
      refresh()
      if (renderedPath.current !== path) {
        renderedPath.current = path
        if (anchor && scrollToId(anchor, false)) reaim(anchor)
        else scrollRef.current!.scrollTop = 0
      }
      updateActive()
    }, [page.text, page.loadedPath, mode, path, anchor, refresh, scrollToId, reaim, updateActive])

    // Пометка ссылок — отдельным лёгким проходом: дерево приезжает своим темпом
    // (и меняется при каждой правке), перерисовывать из-за него документ незачем.
    useEffect(() => {
      const doc = docRef.current
      if (mode !== 'view' || !doc || page.loadedPath !== path) return
      markLinks(doc, path, pages, t('missingPage'))
    }, [pages, page.text, page.loadedPath, mode, path])

    // Переход к разделу той же страницы (ссылка из другой вкладки, кнопка «назад»).
    useEffect(() => {
      if (anchor && mode === 'view') scrollToId(anchor, true)
    }, [anchor, mode, scrollToId])

    useEffect(() => {
      if (!zoom) return
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null) }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [zoom])

    const captureView = useCallback(() => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      const v = docRef.current
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
        if (next !== null) edit(next)
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
    }, [path, onNavigate, edit, scrollToId, rememberAnchor])

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
        page.flush()
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
            {page.saveError ? (
              <span className={`${styles.status} ${styles.statusBad}`}>
                <TriangleAlert size={12} strokeWidth={2.2} /> {t('saveFailed')}
              </span>
            ) : mode === 'edit' ? (
              <span className={styles.status}>{page.saving || page.dirty ? t('saving') : t('saved')}</span>
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
          {page.loadError ? (
            <div className={styles.failed}>
              <TriangleAlert size={17} strokeWidth={2} />
              <span>{t('loadFailed')}</span>
              <button onClick={page.reload}>{t('retry')}</button>
            </div>
          ) : mode === 'view' ? (
            <div
              ref={scrollRef}
              className={`${styles.view} scroll`}
              onScroll={updateActive}
              onMouseUp={captureView}
              onClick={onViewClick}
            >
              <div ref={docRef} className={styles.doc} />
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              className={`${styles.editor} scroll`}
              value={page.text}
              spellCheck={false}
              onChange={e => page.edit(e.target.value)}
              onKeyDown={onKeyDown}
              onSelect={captureEdit}
              onBlur={page.flush}
            />
          )}
          {mode === 'view' && !page.loadError && (
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
