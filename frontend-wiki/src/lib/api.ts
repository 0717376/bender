import { authHeaders, getToken } from './auth'
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
  return data.tree
}

export async function fetchFile(path: string): Promise<string> {
  const res = await fetch(API + '/files/content?path=' + encodeURIComponent(path), { headers: authHeaders() })
  if (!res.ok) throw new Error('file error')
  const data = await res.json()
  return data.text
}

export async function saveFile(path: string, text: string): Promise<void> {
  const res = await fetch(API + '/files/content', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path, text }),
  })
  if (!res.ok) throw new Error('save error')
}

export async function createNode(path: string, type: 'file' | 'dir'): Promise<void> {
  const res = await fetch(API + '/files/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path, type }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || 'create error')
  }
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

export async function deleteNode(path: string): Promise<void> {
  const res = await fetch(API + '/files?path=' + encodeURIComponent(path), {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error('delete error')
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
