import { useEffect } from 'react'
import { Moon, MonitorSmartphone, Sun, X } from 'lucide-react'
import { lang, setLang, t, type Lang } from '../lib/i18n'
import styles from './SettingsModal.module.css'

export type ThemeMode = 'light' | 'dark' | 'auto'

const PALETTES: { key: string; name: string; grad: [string, string] }[] = [
  { key: 'halo', name: 'Halo', grad: ['#D9824F', '#C05A39'] },
  { key: 'indigo', name: t('palIndigo'), grad: ['#7B74F0', '#4F46E5'] },
  { key: 'forest', name: t('palForest'), grad: ['#55A17E', '#2F7A57'] },
  { key: 'ocean', name: t('palOcean'), grad: ['#2BA3BE', '#0E7490'] },
  { key: 'plum', name: t('palPlum'), grad: ['#9F82D9', '#7C5CBF'] },
  { key: 'amber', name: t('palAmber'), grad: ['#F59E0B', '#D97706'] },
  { key: 'rosewood', name: t('palRosewood'), grad: ['#CE8AA0', '#B4637A'] },
  { key: 'ink', name: t('palInk'), grad: ['#4A4A4A', '#262626'] },
  { key: 'matcha', name: t('palMatcha'), grad: ['#90A472', '#6F8352'] },
  { key: 'sky', name: t('palSky'), grad: ['#5B9BFF', '#2E7CF6'] },
]

const MODES: { key: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { key: 'light', label: t('themeLight'), Icon: Sun },
  { key: 'dark', label: t('themeDark'), Icon: Moon },
  { key: 'auto', label: t('themeAuto'), Icon: MonitorSmartphone },
]

const LANGS: { key: Lang; label: string }[] = [
  { key: 'ru', label: t('langRu') },
  { key: 'en', label: t('langEn') },
]

interface SettingsModalProps {
  mode: ThemeMode
  palette: string
  onMode: (m: ThemeMode) => void
  onPalette: (p: string) => void
  onClose: () => void
}

export function SettingsModal({ mode, palette, onMode, onPalette, onClose }: SettingsModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className={styles.scrim} onMouseDown={onClose}>
      <div className={styles.card} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          <h2>{t('settings')}</h2>
          <button className={styles.x} onClick={onClose} aria-label={t('close')}><X size={16} /></button>
        </div>

        <div className={styles.label}>{t('theme')}</div>
        <div className={styles.seg}>
          {MODES.map(({ key, label, Icon }) => (
            <button key={key} data-on={mode === key} onClick={() => onMode(key)}>
              <Icon size={14} strokeWidth={2} />{label}
            </button>
          ))}
        </div>

        <div className={styles.label}>{t('palette')}</div>
        <div className={styles.palGrid}>
          {PALETTES.map((p) => (
            <button
              key={p.key}
              className={styles.palTile}
              data-on={palette === p.key}
              onClick={() => onPalette(p.key)}
            >
              <span className={styles.palSw} style={{ background: `linear-gradient(135deg, ${p.grad[0]}, ${p.grad[1]})` }} />
              <span className={styles.palNm}>{p.name}</span>
            </button>
          ))}
        </div>

        <div className={styles.label}>{t('language')}</div>
        <div className={styles.seg}>
          {LANGS.map((l) => (
            <button key={l.key} data-on={lang === l.key} onClick={() => setLang(l.key)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
