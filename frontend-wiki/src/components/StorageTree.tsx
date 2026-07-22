import { useState, useRef, useEffect } from 'react'
import {
  HardDrive, ChevronRight, Folder, FolderOpen, FolderPlus,
  Pencil, Trash2, FolderUp, Settings, Upload,
} from 'lucide-react'
import type { FileNode } from '../lib/types'
import { storageUpload, storageMkdir, storageMove, storageDelete } from '../lib/api'
import { fileIcon } from '../lib/fileIcons'
import { RowMenu, type MenuItem } from './RowMenu'
import styles from './FileTree.module.css'
import { t, confirmDelete } from '../lib/i18n'

interface TreeCtx {
  selectedPath: string | null
  onSelect: (path: string) => void
  creating: string | null
  renaming: string | null
  startCreate: (parent: string) => void
  startRename: (path: string) => void
  submitCreate: (name: string) => void
  submitRename: (node: FileNode, name: string) => void
  cancel: () => void
  remove: (path: string) => void
  dropTarget: string | null
  onDragStart: (e: React.DragEvent, path: string) => void
  onDragOverDir: (e: React.DragEvent, dest: string) => void
  onDropDir: (e: React.DragEvent, dest: string) => void
  onDragEnd: () => void
}

interface StorageTreeProps {
  tree: FileNode[]
  selectedPath: string | null
  onSelect: (path: string) => void
  onChanged: () => void
  onSettings: () => void
  header?: React.ReactNode
}

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const baseOf = (p: string) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p)
const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name)

export function StorageTree({ tree, selectedPath, onSelect, onChanged, onSettings, header }: StorageTreeProps) {
  const [creating, setCreating] = useState<string | null>(null)   // parent dir of the new folder
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragPathRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadDirRef = useRef('')

  const startCreate = (parent: string) => { setRenaming(null); setCreating(parent) }
  const startRename = (path: string) => { setCreating(null); setRenaming(path) }
  const cancel = () => { setCreating(null); setRenaming(null) }

  const submitCreate = async (name: string) => {
    if (creating == null || !name) { cancel(); return }
    const path = join(creating, name)
    cancel()
    try {
      await storageMkdir(path)
      onChanged()
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const submitRename = async (node: FileNode, name: string) => {
    const dst = join(parentOf(node.path), name)
    cancel()
    if (!name || dst === node.path) return
    try {
      await storageMove(node.path, dst)
      onChanged()
      fixSelection(node.path, dst)
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const remove = async (path: string) => {
    if (!confirm(confirmDelete(path))) return
    try {
      await storageDelete(path)
      if (selectedPath === path || selectedPath?.startsWith(path + '/')) onSelect('')
      onChanged()
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const fixSelection = (src: string, dst: string) => {
    if (selectedPath === src) onSelect(dst)
    else if (selectedPath && selectedPath.startsWith(src + '/')) onSelect(dst + selectedPath.slice(src.length))
  }

  const uploadTo = async (dir: string, files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      try {
        await storageUpload(dir, f)
      } catch (e) {
        alert(`${f.name}: ${(e as Error).message}`)
      }
    }
    onChanged()
  }

  const pickUpload = (dir: string) => {
    uploadDirRef.current = dir
    fileInputRef.current?.click()
  }

  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

  const canDrop = (src: string | null, dest: string) => {
    if (src == null) return false
    if (dest === parentOf(src)) return false
    if (dest === src || dest.startsWith(src + '/')) return false
    return true
  }

  const onDragStart = (e: React.DragEvent, path: string) => {
    dragPathRef.current = path
    setDragging(true)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', path)
  }

  const onDragOverDir = (e: React.DragEvent, dest: string) => {
    if (isFileDrag(e)) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      if (dropTarget !== dest) setDropTarget(dest)
      return
    }
    if (!canDrop(dragPathRef.current, dest)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (dropTarget !== dest) setDropTarget(dest)
  }

  const onDropDir = async (e: React.DragEvent, dest: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    if (isFileDrag(e)) {
      await uploadTo(dest, e.dataTransfer.files)
      return
    }
    const src = dragPathRef.current
    dragPathRef.current = null
    setDragging(false)
    if (!canDrop(src, dest) || src == null) return
    const dst = join(dest, baseOf(src))
    try {
      await storageMove(src, dst)
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
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) uploadTo(uploadDirRef.current, e.target.files)
          e.target.value = ''
        }}
      />
      <div className={styles.toolbar}>
        {header ?? (
          <span className={styles.brand}>
            <span className={styles.logo}><HardDrive size={14} strokeWidth={2.4} /></span>
            <span className={styles.heading}>{t('storage')}</span>
          </span>
        )}
        <div className={styles.actions}>
          <button title={t('upload')} onClick={() => pickUpload(toolbarParent)}><Upload size={15} /></button>
          <button title={t('newFolder')} onClick={() => startCreate(toolbarParent)}><FolderPlus size={15} /></button>
        </div>
      </div>
      <div
        className={`${styles.list} scroll`}
        onDragOver={(e) => onDragOverDir(e, '')}
        onDrop={(e) => onDropDir(e, '')}
      >
        {creating === '' && (
          <InlineInput icon={<Folder size={15} />} onSubmit={submitCreate} onCancel={cancel} />
        )}
        {tree.length === 0 && creating == null && <div className={styles.emptyHint}>{t('emptyStorage')}</div>}
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
  const [open, setOpen] = useState(false)
  const isDir = node.type === 'dir'
  const isSelected = node.path === ctx.selectedPath

  if (ctx.renaming === node.path) {
    return (
      <InlineInput
        initial={baseOf(node.path)}
        icon={isDir ? <Folder size={15} /> : fileIcon(node.name)}
        onSubmit={(name) => ctx.submitRename(node, name)}
        onCancel={ctx.cancel}
      />
    )
  }

  const dirDnd = isDir
    ? {
        onDragOver: (e: React.DragEvent) => ctx.onDragOverDir(e, node.path),
        onDrop: (e: React.DragEvent) => ctx.onDropDir(e, node.path),
      }
    : {}

  const menu: MenuItem[] = [
    ...(isDir ? [
      { icon: <FolderPlus size={14} />, label: t('newFolderHere'), onClick: () => { setOpen(true); ctx.startCreate(node.path) } },
    ] : []),
    { icon: <Pencil size={14} />, label: t('rename'), onClick: () => ctx.startRename(node.path) },
    { icon: <Trash2 size={14} />, label: t('delete'), danger: true, onClick: () => ctx.remove(node.path) },
  ]

  return (
    <div className={styles.node} {...dirDnd}>
      <div
        className={`${styles.row} ${isSelected ? styles.selected : ''} ${ctx.dropTarget === node.path ? styles.dropTarget : ''}`}
        draggable
        onDragStart={(e) => ctx.onDragStart(e, node.path)}
        onDragEnd={ctx.onDragEnd}
        onClick={() => { if (isDir) setOpen(o => !o); ctx.onSelect(node.path) }}
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
          {isDir ? (open ? <FolderOpen size={15} /> : <Folder size={15} />) : fileIcon(node.name)}
        </span>
        <span className={styles.name}>{node.name}</span>
        <RowMenu items={menu} className={styles.dots} />
      </div>
      {isDir && open && (
        <div className={styles.children}>
          {ctx.creating === node.path && (
            <InlineInput icon={<Folder size={15} />} onSubmit={ctx.submitCreate} onCancel={ctx.cancel} />
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
  initial?: string
  icon: React.ReactNode
  onSubmit: (name: string) => void
  onCancel: () => void
}

function InlineInput({ initial = '', icon, onSubmit, onCancel }: InlineInputProps) {
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
        placeholder={t('folderName')}
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
