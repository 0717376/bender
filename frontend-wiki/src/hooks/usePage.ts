import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchFile, saveFile } from '../lib/api'

const SAVE_DELAY = 600

export interface Page {
  text: string
  /** Путь, к которому относится text: пока грузим новую страницу, на экране ещё старая. */
  loadedPath: string | null
  loadError: boolean
  saveError: boolean
  dirty: boolean
  saving: boolean
  /** Правка пользователя: сразу на экран, на диск — с задержкой. */
  edit: (value: string) => void
  /** Cmd+S, уход из редактора: дописать не дожидаясь таймера. */
  flush: () => void
  /** Файл изменился снаружи (агент, Telegram, другая вкладка). */
  reload: () => void
}

/** Содержимое одной страницы: загрузка, автосохранение, состояние ошибок. */
export function usePage(path: string | null): Page {
  const [text, setText] = useState('')
  const [loadedPath, setLoadedPath] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const textRef = useRef('')
  textRef.current = text
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const saveTimer = useRef<number | undefined>(undefined)
  const wantRef = useRef<string | null>(null)

  const doSave = useCallback(async (p: string, content: string) => {
    setSaving(true)
    try {
      await saveFile(p, content)
      setSaveError(false)
      if (textRef.current === content) setDirty(false)
    } catch {
      setSaveError(true) // остаёмся dirty: следующая правка попробует снова
    } finally {
      setSaving(false)
    }
  }, [])

  const load = useCallback(async (p: string) => {
    wantRef.current = p
    try {
      const content = await fetchFile(p)
      if (wantRef.current !== p) return // пока грузили, открыли другую страницу
      setText(content)
      setLoadError(false)
    } catch {
      if (wantRef.current !== p) return
      setText('')
      setLoadError(true)
    }
    setLoadedPath(p)
    setDirty(false)
    setSaveError(false)
  }, [])

  useEffect(() => {
    if (path) load(path)
    else { wantRef.current = null; setText(''); setLoadedPath(null); setLoadError(false) }
  }, [path, load])

  // Уходя со страницы (и при закрытии вкладки) дописываем то, что не успел таймер.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (dirtyRef.current && path) saveFile(path, textRef.current).catch(() => {})
    }
  }, [path])

  const edit = useCallback((value: string) => {
    setText(value)
    setDirty(true)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (path) saveTimer.current = window.setTimeout(() => doSave(path, value), SAVE_DELAY)
  }, [path, doSave])

  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (path && dirtyRef.current) doSave(path, textRef.current)
  }, [path, doSave])

  // Свои несохранённые правки важнее чужих: перечитываем только чистую страницу.
  const reload = useCallback(() => {
    if (path && !dirtyRef.current) load(path)
  }, [path, load])

  return { text, loadedPath, loadError, saveError, dirty, saving, edit, flush, reload }
}
