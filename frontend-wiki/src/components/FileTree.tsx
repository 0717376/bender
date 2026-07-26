import { useState, useRef, useEffect } from 'react'
import {
  BookOpen, ChevronRight, Download, Folder, FolderOpen, FileText,
  FilePlus2, FolderPlus, Pencil, Trash2, FolderUp, Search, Settings,
} from 'lucide-react'
import type { FileNode } from '../lib/types'
import { pageLabel } from '../lib/pageIndex'
import { createNode, createChild, renameNode, deleteNode, fetchFile } from '../lib/api'
import { RowMenu, type MenuItem } from './RowMenu'
import { useUi } from './Ui'
import styles from './FileTree.module.css'
import { t } from '../lib/i18n'

type NewKind = 'file' | 'dir' | 'child'
type Creating = { parent: string; type: NewKind } | null

interface TreeCtx {
  selectedPath: string | null
  onSelect: (path: string | null) => void
  creating: Creating
  renaming: string | null
  startCreate: (parent: string, type: NewKind) => void
  startRename: (path: string) => void
  submitCreate: (name: string) => void
  submitRename: (node: FileNode, name: string) => void
  cancel: () => void
  remove: (node: FileNode) => void
  download: (path: string) => void
  // drag & drop
  dropTarget: string | null
  onDragStart: (e: React.DragEvent, path: string) => void
  onDragOverDir: (e: React.DragEvent, dest: string) => void
  onDropDir: (e: React.DragEvent, dest: string) => void
  onDragEnd: () => void
}

interface FileTreeProps {
  tree: FileNode[]
  selectedPath: string | null
  onSelect: (path: string | null) => void
  onChanged: () => void
  onSettings: () => void
  onSearch: () => void
  header?: React.ReactNode
}

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const baseOf = (p: string) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p)
const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name)

export function FileTree({ tree, selectedPath, onSelect, onChanged, onSettings, onSearch, header }: FileTreeProps) {
  const { notify, ask } = useUi()
  const [creating, setCreating] = useState<Creating>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragPathRef = useRef<string | null>(null)

  const startCreate = (parent: string, type: NewKind) => {
    setRenaming(null)
    setCreating({ parent, type })
  }
  const startRename = (path: string) => {
    setCreating(null)
    setRenaming(path)
  }
  const cancel = () => { setCreating(null); setRenaming(null) }

  const submitCreate = async (name: string) => {
    if (!creating || !name) { cancel(); return }
    const { parent, type } = creating
    cancel()
    try {
      if (type === 'child') {
        // Родитель-страница станет папкой со своим index.md — это делает бэкенд.
        onSelect(await createChild(parent, name))
        onChanged()
        return
      }
      let leaf = name
      if (type === 'file' && !leaf.endsWith('.md')) leaf += '.md'
      const path = await createNode(join(parent, leaf), type)
      onChanged()
      if (type === 'file') onSelect(path)
    } catch (e) {
      notify((e as Error).message, 'error')
    }
  }

  const submitRename = async (node: FileNode, name: string) => {
    const dst = join(parentOf(node.path), name)
    cancel()
    if (!name || dst === node.path) return
    try {
      await renameNode(node.path, dst)
      onChanged()
      fixSelection(node.path, dst)
    } catch (e) {
      notify((e as Error).message, 'error')
    }
  }

  const remove = async (node: FileNode) => {
    const branch = node.type === 'dir' && !!node.children?.length
    const ok = await ask(branch ? t('deleteFolderQ') : t('deletePageQ'), node.path)
    if (!ok) return
    try {
      const trashed = await deleteNode(node.path)
      onChanged()
      // Удалили то, что открыто, — иначе в центре осталась бы страница-призрак.
      if (selectedPath === node.path || selectedPath?.startsWith(node.path + '/')) onSelect(null)
      notify(t('deleted'), 'info', {
        label: t('undo'),
        run: () => {
          renameNode(trashed, node.path)
            .then(onChanged)
            .catch(e => notify((e as Error).message, 'error'))
        },
      })
    } catch (e) {
      notify((e as Error).message, 'error')
    }
  }

  // Скачать markdown-исходник страницы (<a download> не умеет Bearer — тянем сами).
  const download = async (path: string) => {
    try {
      const text = await fetchFile(path)
      const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = baseOf(path)
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      notify((e as Error).message, 'error')
    }
  }

  // Keep the open page selected after it (or its parent folder) is moved/renamed.
  const fixSelection = (src: string, dst: string) => {
    if (selectedPath === src) onSelect(dst)
    else if (selectedPath && selectedPath.startsWith(src + '/')) onSelect(dst + selectedPath.slice(src.length))
  }

  const canDrop = (src: string | null, dest: string) => {
    if (src == null) return false
    if (dest === parentOf(src)) return false               // already there
    if (dest === src || dest.startsWith(src + '/')) return false  // into itself / descendant
    return true
  }

  const onDragStart = (e: React.DragEvent, path: string) => {
    dragPathRef.current = path
    setDragging(true)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', path)
  }

  const onDragOverDir = (e: React.DragEvent, dest: string) => {
    if (!canDrop(dragPathRef.current, dest)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (dropTarget !== dest) setDropTarget(dest)
  }

  const onDropDir = async (e: React.DragEvent, dest: string) => {
    e.preventDefault()
    e.stopPropagation()
    const src = dragPathRef.current
    dragPathRef.current = null
    setDragging(false)
    setDropTarget(null)
    if (!canDrop(src, dest) || src == null) return
    const dst = join(dest, baseOf(src))
    try {
      await renameNode(src, dst)
      onChanged()
      fixSelection(src, dst)
    } catch (err) {
      notify((err as Error).message, 'error')
    }
  }

  const onDragEnd = () => { dragPathRef.current = null; setDragging(false); setDropTarget(null) }

  const toolbarParent = selectedPath ? parentOf(selectedPath) : ''

  const ctx: TreeCtx = {
    selectedPath, onSelect, creating, renaming,
    startCreate, startRename, submitCreate, submitRename, cancel, remove, download,
    dropTarget, onDragStart, onDragOverDir, onDropDir, onDragEnd,
  }

  return (
    <div className={styles.tree}>
      <div className={styles.toolbar}>
        {header ?? (
          <span className={styles.brand}>
            <span className={styles.logo}><BookOpen size={14} strokeWidth={2.4} /></span>
            <span className={styles.heading}>{t('wiki')}</span>
          </span>
        )}
        <div className={styles.actions}>
          <button title={`${t('search')} (⌘K)`} aria-label={t('search')} onClick={onSearch}><Search size={15} /></button>
          <button title={t('newPage')} onClick={() => startCreate(toolbarParent, 'file')}><FilePlus2 size={15} /></button>
          <button title={t('newFolder')} onClick={() => startCreate(toolbarParent, 'dir')}><FolderPlus size={15} /></button>
        </div>
      </div>
      <div
        className={`${styles.list} scroll`}
        onDragOver={(e) => onDragOverDir(e, '')}
        onDrop={(e) => onDropDir(e, '')}
      >
        {creating?.parent === '' && (
          <InlineInput
            kind={creating.type}
            icon={creating.type === 'dir' ? <Folder size={15} /> : <FileText size={15} />}
            onSubmit={submitCreate}
            onCancel={cancel}
          />
        )}
        {tree.length === 0 && !creating && <div className={styles.emptyHint}>{t('emptyTree')}</div>}
        {tree.map(node => (
          <TreeNode key={node.path} node={node} ctx={ctx} />
        ))}
      </div>
      {dragging && (
        <div
          className={`${styles.rootDrop} ${dropTarget === '' ? styles.rootDropActive : ''}`}
          onDragOver={(e) => onDragOverDir(e, '')}
          onDrop={(e) => onDropDir(e, '')}
        >
          <FolderUp size={15} />
          <span>{t('moveToRoot')}</span>
        </div>
      )}
      <div className={styles.foot}>
        <button className={styles.gear} title={t('settings')} onClick={onSettings} aria-label={t('settings')}>
          <Settings size={16} strokeWidth={1.9} />
        </button>
      </div>
    </div>
  )
}

function TreeNode({ node, ctx }: { node: FileNode; ctx: TreeCtx }) {
  const [open, setOpen] = useState(false) // folders start collapsed
  const isDir = node.type === 'dir'
  // Узел — страница, если у него есть page (папка с index.md — тоже страница, только
  // с детьми): строка открывает её, шеврон разворачивает детей.
  const pagePath = node.page ?? null
  const isSelected = !!pagePath && pagePath === ctx.selectedPath

  // Страницу могли открыть мимо дерева (прямая ссылка, поиск, чат) — раскрываем
  // папки по пути к ней, иначе непонятно, где ты находишься.
  const onPath = isDir && !!ctx.selectedPath?.startsWith(node.path + '/')
  useEffect(() => { if (onPath) setOpen(true) }, [onPath])

  const beginCreate = (type: NewKind) => {
    setOpen(true)
    ctx.startCreate(type === 'child' && pagePath ? pagePath : node.path, type)
  }

  const menu: MenuItem[] = [
    { icon: <FilePlus2 size={14} />, label: t('newChild'), onClick: () => beginCreate('child') },
    ...(isDir ? [
      { icon: <FolderPlus size={14} />, label: t('newFolderHere'), onClick: () => beginCreate('dir') },
    ] : []),
    ...(pagePath ? [
      { icon: <Download size={14} />, label: t('download'), onClick: () => ctx.download(pagePath) },
    ] : []),
    { icon: <Pencil size={14} />, label: t('rename'), onClick: () => ctx.startRename(node.path) },
    { icon: <Trash2 size={14} />, label: t('delete'), danger: true, onClick: () => ctx.remove(node) },
  ]

  if (ctx.renaming === node.path) {
    return (
      <InlineInput
        kind={isDir ? 'dir' : 'file'}
        initial={baseOf(node.path)}
        icon={isDir && !node.page ? <Folder size={15} /> : <FileText size={15} />}
        onSubmit={(name) => ctx.submitRename(node, name)}
        onCancel={ctx.cancel}
      />
    )
  }

  // Folders are drop targets (the whole node region routes into this folder).
  const dirDnd = isDir
    ? {
        onDragOver: (e: React.DragEvent) => ctx.onDragOverDir(e, node.path),
        onDrop: (e: React.DragEvent) => ctx.onDropDir(e, node.path),
      }
    : {}

  const hasKids = isDir && !!node.children?.length
  const creatingHere = ctx.creating?.parent === node.path || ctx.creating?.parent === pagePath

  return (
    <div className={styles.node} {...dirDnd}>
      <div
        className={`${styles.row} ${isSelected ? styles.selected : ''} ${ctx.dropTarget === node.path ? styles.dropTarget : ''}`}
        draggable
        onDragStart={(e) => ctx.onDragStart(e, node.path)}
        onDragEnd={ctx.onDragEnd}
        onClick={() => (pagePath ? ctx.onSelect(pagePath) : setOpen(o => !o))}
      >
        <span
          className={styles.chevron}
          onClick={(e) => { if (isDir) { e.stopPropagation(); setOpen(o => !o) } }}
        >
          {isDir && (
            <ChevronRight
              size={14}
              className={`${styles.chevronIcon} ${open ? styles.chevronOpen : ''}`}
            />
          )}
        </span>
        <span className={styles.fileIcon}>
          {isDir && !node.page
            ? (open ? <FolderOpen size={15} /> : <Folder size={15} />)
            : <FileText size={15} />}
        </span>
        <span className={styles.name}>{node.title || pageLabel(node.path)}</span>
        <RowMenu items={menu} className={styles.dots} />
      </div>
      {(creatingHere || (hasKids && open)) && (
        <div className={styles.children}>
          {creatingHere && (
            <InlineInput
              kind={ctx.creating!.type}
              icon={ctx.creating!.type === 'dir' ? <Folder size={15} /> : <FileText size={15} />}
              onSubmit={ctx.submitCreate}
              onCancel={ctx.cancel}
            />
          )}
          {open && node.children?.map(child => (
            <TreeNode key={child.path} node={child} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  )
}

interface InlineInputProps {
  kind: NewKind
  initial?: string
  icon: React.ReactNode
  onSubmit: (name: string) => void
  onCancel: () => void
}

const PLACEHOLDER: Record<NewKind, 'folderName' | 'pageName' | 'childName'> = {
  dir: 'folderName',
  file: 'pageName',
  child: 'childName',
}

function InlineInput({ kind, initial = '', icon, onSubmit, onCancel }: InlineInputProps) {
  const [value, setValue] = useState(initial)
  const doneRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    const dot = initial.lastIndexOf('.')
    if (dot > 0) el.setSelectionRange(0, dot)
    else el.select()
  }, [initial])

  const finish = (commit: boolean) => {
    if (doneRef.current) return
    doneRef.current = true
    const v = value.trim()
    if (commit && v) onSubmit(v)
    else onCancel()
  }

  return (
    <div className={`${styles.row} ${styles.inlineRow}`}>
      <span className={styles.chevron} />
      <span className={styles.fileIcon}>{icon}</span>
      <input
        ref={inputRef}
        className={styles.inlineInput}
        value={value}
        spellCheck={false}
        placeholder={t(PLACEHOLDER[kind])}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish(true) }
          else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
        }}
        onBlur={() => finish(true)}
      />
    </div>
  )
}
