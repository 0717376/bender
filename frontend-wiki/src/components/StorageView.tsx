import { useEffect, useState } from 'react'
import { Download, ExternalLink, File as FileIcon, FileQuestion } from 'lucide-react'
import { storageFileUrl } from '../lib/api'
import styles from './StorageView.module.css'
import { t, lang } from '../lib/i18n'

interface StorageViewProps {
  path: string | null
  size?: number
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

export function StorageView({ path, size, onMissing }: StorageViewProps) {
  const [missing, setMissing] = useState(false)

  // A stale tree can point at a file the agent has already moved (e.g. out of
  // the inbox via Telegram) — probe first instead of iframing a JSON 404.
  useEffect(() => {
    setMissing(false)
    if (!path) return
    let alive = true
    fetch(storageFileUrl(path), { method: 'HEAD' })
      .then(r => { if (alive && !r.ok) { setMissing(true); onMissing?.() } })
      .catch(() => {})
    return () => { alive = false }
  }, [path, onMissing])

  if (!path) {
    return <div className={styles.pane}><div className={styles.empty}>{t('pickFile')}</div></div>
  }
  if (missing) {
    return (
      <div className={styles.pane}>
        <div className={styles.fallback}>
          <FileQuestion size={40} strokeWidth={1.2} />
          <div className={styles.fname}>{path}</div>
          <div className={styles.fsize}>{t('fileMissing')}</div>
        </div>
      </div>
    )
  }
  const url = storageFileUrl(path)
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path

  let body: React.ReactNode
  if (isImage(path)) {
    body = <div className={`${styles.media} scroll`}><img src={url} alt={name} /></div>
  } else if (isPdf(path) || isText(path)) {
    body = <iframe className={styles.frame} src={url} title={name} />
  } else if (isVideo(path)) {
    body = <div className={styles.media}><video src={url} controls /></div>
  } else if (isAudio(path)) {
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
        <span className={styles.path}>{path}{size != null && <span className={styles.dim}> · {formatSize(size)}</span>}</span>
        <div className={styles.barActions}>
          <a href={url} target="_blank" rel="noopener noreferrer" title={t('openInTab')}><ExternalLink size={14} /></a>
          <a href={url} download={name} title={t('download')}><Download size={14} /></a>
        </div>
      </div>
      {body}
    </div>
  )
}
