import { useState, useRef, useEffect } from 'react'
import {
  ChevronRight, Folder, FolderOpen, FileText,
  FilePlus2, FolderPlus, RotateCw, Pencil, Trash2, FolderUp, Settings,
} from 'lucide-react'
import type { FileNode } from '../lib/types'
import { createNode, renameNode, deleteNode } from '../lib/api'
import styles from './FileTree.module.css'
import { t, confirmDelete } from '../lib/i18n'

type Creating = { parent: string; type: 'file' | 'dir' } | null

interface TreeCtx {
  selectedPath: string | null
  onSelect: (path: string) => void
  creating: Creating
  renaming: string | null
  startCreate: (parent: string, type: 'file' | 'dir') => void
  startRename: (path: string) => void
  submitCreate: (name: string) => void
  submitRename: (node: FileNode, name: string) => void
  cancel: () => void
  remove: (path: string) => void
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
  onSelect: (path: string) => void
  onChanged: () => void
  onSettings: () => void
}

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const baseOf = (p: string) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p)
const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name)

export function FileTree({ tree, selectedPath, onSelect, onChanged, onSettings }: FileTreeProps) {
  const [creating, setCreating] = useState<Creating>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragPathRef = useRef<string | null>(null)

  const startCreate = (parent: string, type: 'file' | 'dir') => {
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
    let leaf = name
    if (creating.type === 'file' && !leaf.endsWith('.md')) leaf += '.md'
    const path = join(creating.parent, leaf)
    cancel()
    try {
      await createNode(path, creating.type)
      onChanged()
      if (creating.type === 'file') onSelect(path)
    } catch (e) {
      alert((e as Error).message)
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
      alert((e as Error).message)
    }
  }

  const remove = async (path: string) => {
    if (!confirm(confirmDelete(path))) return
    try {
      await deleteNode(path)
      onChanged()
    } catch (e) {
      alert((e as Error).message)
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
      alert((err as Error).message)
    }
  }

  const onDragEnd = () => { dragPathRef.current = null; setDragging(false); setDropTarget(null) }

  const toolbarParent = selectedPath ? parentOf(selectedPath) : ''

  const ctx: TreeCtx = {
    selectedPath, onSelect, creating, renaming,
    startCreate, startRename, submitCreate, submitRename, cancel, remove,
    dropTarget, onDragStart, onDragOverDir, onDropDir, onDragEnd,
  }

  return (
    <div className={styles.tree}>
      <div className={styles.toolbar}>
        <span className={styles.brand}>
          <span className={styles.logo}><span /></span>
          <span className={styles.heading}>{t('wiki')}</span>
        </span>
        <div className={styles.actions}>
          <button title={t('newPage')} onClick={() => startCreate(toolbarParent, 'file')}><FilePlus2 size={15} /></button>
          <button title={t('newFolder')} onClick={() => startCreate(toolbarParent, 'dir')}><FolderPlus size={15} /></button>
          <button title={t('refresh')} onClick={onChanged}><RotateCw size={14} /></button>
        </div>
      </div>
      <div
        className={`${styles.list} scroll`}
        onDragOver={(e) => onDragOverDir(e, '')}
        onDrop={(e) => onDropDir(e, '')}
      >
        {creating?.parent === '' && (
          <InlineInput
            type={creating.type}
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
  const isSelected = !isDir && node.path === ctx.selectedPath

  const beginCreate = (e: React.MouseEvent, type: 'file' | 'dir') => {
    e.stopPropagation()
    setOpen(true)
    ctx.startCreate(node.path, type)
  }

  if (ctx.renaming === node.path) {
    return (
      <InlineInput
        type={node.type}
        initial={baseOf(node.path)}
        icon={isDir ? <Folder size={15} /> : <FileText size={15} />}
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

  return (
    <div className={styles.node} {...dirDnd}>
      <div
        className={`${styles.row} ${isSelected ? styles.selected : ''} ${ctx.dropTarget === node.path ? styles.dropTarget : ''}`}
        draggable
        onDragStart={(e) => ctx.onDragStart(e, node.path)}
        onDragEnd={ctx.onDragEnd}
        onClick={() => (isDir ? setOpen(o => !o) : ctx.onSelect(node.path))}
      >
        <span className={styles.chevron}>
          {isDir && (
            <ChevronRight
              size={14}
              className={`${styles.chevronIcon} ${open ? styles.chevronOpen : ''}`}
            />
          )}
        </span>
        <span className={styles.fileIcon}>
          {isDir ? (open ? <FolderOpen size={15} /> : <Folder size={15} />) : <FileText size={15} />}
        </span>
        <span className={styles.name}>{node.name}</span>
        <span className={styles.rowActions}>
          {isDir && <>
            <button title={t('newPageHere')} onClick={(e) => beginCreate(e, 'file')}><FilePlus2 size={13} /></button>
            <button title={t('newFolderHere')} onClick={(e) => beginCreate(e, 'dir')}><FolderPlus size={13} /></button>
          </>}
          <button title={t('rename')} onClick={(e) => { e.stopPropagation(); ctx.startRename(node.path) }}><Pencil size={13} /></button>
          <button title={t('delete')} onClick={(e) => { e.stopPropagation(); ctx.remove(node.path) }}><Trash2 size={13} /></button>
        </span>
      </div>
      {isDir && open && (
        <div className={styles.children}>
          {ctx.creating?.parent === node.path && (
            <InlineInput
              type={ctx.creating.type}
              icon={ctx.creating.type === 'dir' ? <Folder size={15} /> : <FileText size={15} />}
              onSubmit={ctx.submitCreate}
              onCancel={ctx.cancel}
            />
          )}
          {node.children?.map(child => (
            <TreeNode key={child.path} node={child} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  )
}

interface InlineInputProps {
  type: 'file' | 'dir'
  initial?: string
  icon: React.ReactNode
  onSubmit: (name: string) => void
  onCancel: () => void
}

function InlineInput({ type, initial = '', icon, onSubmit, onCancel }: InlineInputProps) {
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
        placeholder={type === 'dir' ? t('folderName') : t('pageName')}
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
