import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { Eye, Pencil } from 'lucide-react'
import { fetchFile, saveFile, storageFileUrl } from '../lib/api'
import { renderMarkdown, enhanceCodeBlocks, resolveWikiPath } from '../lib/markdown'
import styles from './ContentPane.module.css'
import { t } from '../lib/i18n'

interface ContentPaneProps {
  path: string | null
  reloadSignal: number
  onSelectionChange: (text: string) => void
  onNavigate: (path: string) => void
}

export interface ContentPaneHandle {
  getSelection: () => string
  clearSelection: () => void
}

const HL = 'wiki-sel'
const SAVE_DELAY = 600

export const ContentPane = forwardRef<ContentPaneHandle, ContentPaneProps>(
  function ContentPane({ path, reloadSignal, onSelectionChange, onNavigate }, ref) {
    const [text, setText] = useState('')
    const [mode, setMode] = useState<'view' | 'edit'>('view')
    const [dirty, setDirty] = useState(false)
    const [saving, setSaving] = useState(false)
    const viewRef = useRef<HTMLDivElement>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const pinnedRef = useRef('')

    const textRef = useRef('')
    textRef.current = text
    const dirtyRef = useRef(false)
    dirtyRef.current = dirty
    const saveTimer = useRef<number | undefined>(undefined)

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
      try {
        const content = await fetchFile(p)
        setText(content)
        setDirty(false)
      } catch {
        setText('')
      }
    }, [])

    useEffect(() => {
      clearSelection()
      if (path) load(path)
      else setText('')
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

    useEffect(() => {
      if (mode === 'view' && viewRef.current) {
        viewRef.current.innerHTML = renderMarkdown(text)
        enhanceCodeBlocks(viewRef.current)
        // storage:Папка/скан.jpg → authorized /storage/file URL
        viewRef.current.querySelectorAll<HTMLImageElement>('img[src^="storage:"]').forEach(img => {
          img.src = storageFileUrl(img.getAttribute('src')!.slice('storage:'.length))
        })
        viewRef.current.querySelectorAll<HTMLAnchorElement>('a[href^="storage:"]').forEach(a => {
          a.href = storageFileUrl(a.getAttribute('href')!.slice('storage:'.length))
          a.target = '_blank'
          a.rel = 'noopener noreferrer'
        })
      }
    }, [text, mode])

    useEffect(() => { clearSelection() }, [mode, clearSelection])

    const onEdit = (value: string) => {
      setText(value)
      setDirty(true)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (path) saveTimer.current = window.setTimeout(() => doSave(path, value), SAVE_DELAY)
    }

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

    // Intercept clicks on internal markdown links and navigate via app state
    // instead of letting the browser follow a dead relative URL.
    const onViewClick = useCallback((e: React.MouseEvent) => {
      // Respect modifier clicks (open in new tab, etc.).
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
      const anchor = (e.target as HTMLElement).closest('a')
      if (!anchor) return
      const href = anchor.getAttribute('href') || ''
      const target = resolveWikiPath(path, href)
      if (target === null) {
        // External link: open in a new tab to keep the wiki open.
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
          anchor.setAttribute('target', '_blank')
          anchor.setAttribute('rel', 'noopener noreferrer')
        }
        return
      }
      e.preventDefault()
      if (target) onNavigate(target)
    }, [path, onNavigate])

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

    return (
      <div className={styles.pane}>
        <div className={styles.bar}>
          <span className={styles.path}>{path}</span>
          <div className={styles.barActions}>
            {mode === 'edit' && (
              <span className={styles.status}>{saving || dirty ? t('saving') : t('saved')}</span>
            )}
            <button
              className={styles.toggle}
              onClick={() => setMode(m => (m === 'view' ? 'edit' : 'view'))}
            >
              {mode === 'view' ? <><Pencil size={13} /> {t('edit')}</> : <><Eye size={13} /> {t('view')}</>}
            </button>
          </div>
        </div>
        {mode === 'view' ? (
          <div ref={viewRef} className={`${styles.view} scroll`} onMouseUp={captureView} onClick={onViewClick} />
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
      </div>
    )
  }
)
