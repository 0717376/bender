import { authHeaders } from './auth'
import type { FileNode } from './types'

const API = window.location.origin

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
