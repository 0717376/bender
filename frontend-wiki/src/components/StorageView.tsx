import { useEffect, useRef, useState } from 'react'
import { Download, ExternalLink, File as FileIcon, FileQuestion, Folder, HardDrive, Upload } from 'lucide-react'
import type { FileNode } from '../lib/types'
import { storageFileUrl, storageUpload } from '../lib/api'
import { fileIcon } from '../lib/fileIcons'
import styles from './StorageView.module.css'
import { t, lang, formatDay } from '../lib/i18n'

interface StorageViewProps {
  path: string | null
  node: FileNode | null
  entries: FileNode[]
  onSelect: (path: string) => void
  onChanged: () => void
  onMissing?: () => void
}

const isImage = (p: string) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(p)
const isPdf = (p: string) => /\.pdf$/i.test(p)
const isVideo = (p: string) => /\.(mp4|mov|webm)$/i.test(p)
const isAudio = (p: string) => /\.(mp3|ogg|wav|m4a|flac)$/i.test(p)
const isText = (p: string) => /\.(txt|md|json|csv|log)$/i.test(p)

export function formatSize(bytes?: number): string {
  if (bytes == null) return ''
  const units = lang === 'ru' ? ['Б', 'КБ', 'МБ', 'ГБ'] : ['B', 'KB', 'MB', 'GB']
  let v = bytes, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

// Кликабельные крошки: корень «Файлы» + сегменты пути
function Crumbs({ path, onSelect }: { path: string | null; onSelect: (p: string) => void }) {
  const segments = path ? path.split('/') : []
  return (
    <span className={styles.crumbs}>
      <button className={styles.crumbBtn} onClick={() => onSelect('')}>
        <HardDrive size={13} /> {t('storage')}
      </button>
      {segments.map((seg, i) => {
        const last = i === segments.length - 1
        const prefix = segments.slice(0, i + 1).join('/')
        return (
          <span key={i} className={styles.crumb}>
            <span className={styles.crumbSep}>›</span>
            {last
              ? <span className={styles.crumbLeaf}>{seg}</span>
              : <button className={styles.crumbBtn} onClick={() => onSelect(prefix)}>{seg}</button>}
          </span>
        )
      })}
    </span>
  )
}

export function StorageView({ path, node, entries, onSelect, onChanged, onMissing }: StorageViewProps) {
  const [missing, setMissing] = useState(false)
  const isFile = !!path && node?.type === 'file'

  // A stale tree can point at a file the agent has already moved (e.g. out of
  // the inbox via Telegram) — probe first instead of iframing a JSON 404.
  useEffect(() => {
    setMissing(false)
    if (!path || !isFile) return
    let alive = true
    fetch(storageFileUrl(path), { method: 'HEAD' })
      .then(r => { if (alive && r.status === 404) { setMissing(true); onMissing?.() } })
      .catch(() => {})
    return () => { alive = false }
  }, [path, isFile, onMissing])

  if (!isFile) {
    return <FolderView path={path} entries={entries} onSelect={onSelect} onChanged={onChanged} />
  }
  if (missing) {
    return (
      <div className={styles.pane}>
        <div className={styles.bar}><Crumbs path={path} onSelect={onSelect} /></div>
        <div className={styles.fallback}>
          <FileQuestion size={40} strokeWidth={1.2} />
          <div className={styles.fname}>{path}</div>
          <div className={styles.fsize}>{t('fileMissing')}</div>
        </div>
      </div>
    )
  }
  const url = storageFileUrl(path!)
  const name = node!.name
  const size = node!.size

  let body: React.ReactNode
  if (isImage(path!)) {
    body = <div className={`${styles.media} scroll`}><img src={url} alt={name} /></div>
  } else if (isPdf(path!) || isText(path!)) {
    body = <iframe className={styles.frame} src={url} title={name} />
  } else if (isVideo(path!)) {
    body = <div className={styles.media}><video src={url} controls /></div>
  } else if (isAudio(path!)) {
    body = <div className={styles.media}><audio src={url} controls /></div>
  } else {
    body = (
      <div className={styles.fallback}>
        <FileIcon size={40} strokeWidth={1.2} />
        <div className={styles.fname}>{name}</div>
        {size != null && <div className={styles.fsize}>{formatSize(size)}</div>}
        <a className={styles.dl} href={url} download={name}>
          <Download size={14} /> {t('download')}
        </a>
      </div>
    )
  }

  return (
    <div className={styles.pane}>
      <div className={styles.bar}>
        <Crumbs path={path} onSelect={onSelect} />
        <div className={styles.barActions}>
          {size != null && <span className={styles.meta}>{formatSize(size)}</span>}
          <a href={url} target="_blank" rel="noopener noreferrer" title={t('openInTab')}><ExternalLink size={14} /></a>
          <a href={url} download={name} title={t('download')}><Download size={14} /></a>
        </div>
      </div>
      {body}
    </div>
  )
}

// Обзор папки: список содержимого в центре вместо пустого «выберите файл»
function FolderView({ path, entries, onSelect, onChanged }: {
  path: string | null
  entries: FileNode[]
  onSelect: (p: string) => void
  onChanged: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      try {
        await storageUpload(path ?? '', f)
      } catch (e) {
        alert(`${f.name}: ${(e as Error).message}`)
      }
    }
    onChanged()
  }

  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

  return (
    <div
      className={styles.pane}
      onDragOver={(e) => { if (isFileDrag(e)) { e.preventDefault(); setDragOver(true) } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { if (isFileDrag(e)) { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files) } }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) upload(e.target.files)
          e.target.value = ''
        }}
      />
      <div className={styles.bar}>
        <Crumbs path={path} onSelect={onSelect} />
        <div className={styles.barActions}>
          <button className={styles.uploadBtn} onClick={() => inputRef.current?.click()}>
            <Upload size={13} /> {t('upload')}
          </button>
        </div>
      </div>
      {entries.length === 0 ? (
        <div className={styles.fallback}>
          <Upload size={36} strokeWidth={1.2} />
          <div className={styles.fname}>{t('emptyFolder')}</div>
          <div className={styles.fsize}>{t('uploadHint')}</div>
        </div>
      ) : (
        <div className={`${styles.listing} scroll ${dragOver ? styles.dragOver : ''}`}>
          {entries.map(e => (
            <button key={e.path} className={styles.item} onClick={() => onSelect(e.path)}>
              <span className={styles.itemIcon}>
                {e.type === 'dir' ? <Folder size={17} strokeWidth={1.8} /> : fileIcon(e.name, 17)}
              </span>
              <span className={styles.itemName}>{e.name}</span>
              <span className={styles.itemMeta}>
                {e.type === 'file' && e.size != null && <span>{formatSize(e.size)}</span>}
                {e.type === 'file' && e.mtime != null && <span className={styles.itemDate}>{formatDay(e.mtime)}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
