import { authHeaders, getToken } from './auth'
import { normalizeTree } from './pageIndex'
import type { FileNode } from './types'

const API = window.location.origin

async function ok(res: Response, fallback: string): Promise<void> {
  if (res.ok) return
  const data = await res.json().catch(() => ({}))
  throw new Error(data.detail || fallback)
}

export async function checkAuthStatus(): Promise<boolean> {
  if (!localStorage.getItem('token')) return false
  try {
    const res = await fetch(API + '/auth/me', { headers: authHeaders() })
    return res.ok
  } catch {
    return false
  }
}

export async function login(password: string): Promise<{ token?: string; error?: string }> {
  const res = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { error: data.detail || 'Ошибка входа' }
  return data
}

export async function fetchTree(): Promise<FileNode[]> {
  const res = await fetch(API + '/files/tree', { headers: authHeaders() })
  if (!res.ok) throw new Error('tree error')
  const data = await res.json()
  return normalizeTree(data.tree)
}

export async function fetchFile(path: string): Promise<string> {
  const res = await fetch(API + '/files/content?path=' + encodeURIComponent(path), { headers: authHeaders() })
  if (!res.ok) throw new Error('file error')
  const data = await res.json()
  return data.text
}

export interface SearchHit {
  path: string
  title: string
  snippet: string
}

export async function searchPages(q: string): Promise<SearchHit[]> {
  const res = await fetch(API + '/files/search?q=' + encodeURIComponent(q), { headers: authHeaders() })
  if (!res.ok) throw new Error('search error')
  return (await res.json()).results
}

export interface FilesEvent {
  pages: string[]
  storage: boolean
}

// Страницы меняются мимо этой вкладки: агент, Telegram, крон, внешние агенты по MCP.
// EventSource не умеет слать заголовок — токен уходит в query, как и у задач.
export function subscribeFiles(onEvent: (e: FilesEvent) => void): () => void {
  const es = new EventSource(API + '/files/events?token=' + encodeURIComponent(getToken() ?? ''))
  es.addEventListener('files', (e) => {
    try { onEvent(JSON.parse((e as MessageEvent).data)) } catch { /* битый кадр — пропускаем */ }
  })
  return () => es.close()
}

export async function saveFile(path: string, text: string): Promise<void> {
  const res = await fetch(API + '/files/content', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path, text }),
  })
  if (!res.ok) throw new Error('save error')
}

/** Возвращает фактический путь: имя приводится к латинице на бэкенде. */
export async function createPage(path: string): Promise<string> {
  const res = await fetch(API + '/files/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path }),
  })
  await ok(res, 'create error')
  return (await res.json()).path
}

// Дочерняя страница: если родитель был обычной страницей, бэкенд сам продвинет его
// в родительскую (x.md → x/index.md) и починит ссылки.
export async function createChild(parent: string, title: string): Promise<string> {
  const res = await fetch(API + '/files/child', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ parent, title }),
  })
  await ok(res, 'create error')
  return (await res.json()).path
}

/** Перетаскивание в дереве: положить страницу под другую. Родитель, если он был
 *  бездетным, становится родительским сам — клиенту знать об этом не нужно. */
export async function reparent(src: string, parent: string): Promise<string> {
  const res = await fetch(API + '/files/reparent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ src, parent }),
  })
  await ok(res, 'move error')
  return (await res.json()).path
}

export async function renameNode(src: string, dst: string): Promise<void> {
  const res = await fetch(API + '/files/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ src, dst }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || 'rename error')
  }
}

export async function transcribeAudio(blob: Blob): Promise<string | null> {
  const formData = new FormData()
  formData.append('audio', blob, 'recording.webm')
  formData.append('model_id', 'gigaam-rnnt')
  const res = await fetch(API + '/api/asr/transcribe', {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
  })
  if (!res.ok) throw new Error('ASR error')
  const result = await res.json()
  return result.text || null
}

/** Удаление — перенос в корзину; возвращает путь в ней, чтобы можно было отменить. */
export async function deleteNode(path: string): Promise<string> {
  const res = await fetch(API + '/files?path=' + encodeURIComponent(path), {
    method: 'DELETE',
    headers: authHeaders(),
  })
  await ok(res, 'delete error')
  return (await res.json()).trashed
}

// ── MCP access for external agents ──

export async function mcpInfo(): Promise<{ token: string }> {
  const res = await fetch(API + '/api/mcp', { headers: authHeaders() })
  if (!res.ok) throw new Error('mcp error')
  return res.json()
}

export async function mcpRotate(): Promise<{ token: string }> {
  const res = await fetch(API + '/api/mcp/rotate', { method: 'POST', headers: authHeaders() })
  if (!res.ok) throw new Error('mcp error')
  return res.json()
}

// ── Personal file storage (/storage) ──

export async function storageTree(): Promise<FileNode[]> {
  const res = await fetch(API + '/storage/tree', { headers: authHeaders() })
  if (!res.ok) throw new Error('tree error')
  return (await res.json()).tree
}

// <img>/<iframe>/<a download> can't send the Bearer header — token goes in the query.
export function storageFileUrl(path: string): string {
  return API + '/storage/file?path=' + encodeURIComponent(path) + '&token=' + (getToken() ?? '')
}

export async function storageUpload(dir: string, file: File): Promise<void> {
  const formData = new FormData()
  formData.append('file', file, file.name)
  const res = await fetch(API + '/storage/upload?dir=' + encodeURIComponent(dir), {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
  })
  await ok(res, 'upload error')
}

export async function storageMkdir(path: string): Promise<void> {
  const res = await fetch(API + '/storage/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path }),
  })
  await ok(res, 'mkdir error')
}

export async function storageMove(src: string, dst: string): Promise<void> {
  const res = await fetch(API + '/storage/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ src, dst }),
  })
  await ok(res, 'move error')
}

export async function storageDelete(path: string): Promise<void> {
  const res = await fetch(API + '/storage?path=' + encodeURIComponent(path), {
    method: 'DELETE',
    headers: authHeaders(),
  })
  await ok(res, 'delete error')
}
