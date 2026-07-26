// Адрес открытой страницы живёт в hash: `#/infra/machines/hermes.md#docker-и-сервисы`.
// Первый сегмент — путь в вики, всё после второго `#` — якорь раздела.

export interface Route {
  path: string | null
  anchor: string
}

const decode = (s: string): string => {
  try { return decodeURIComponent(s) } catch { return s }
}

export function parseHash(): Route {
  const raw = location.hash.slice(1)
  if (!raw.startsWith('/')) return { path: null, anchor: '' }
  const cut = raw.indexOf('#')
  const path = decode(cut === -1 ? raw.slice(1) : raw.slice(1, cut))
  const anchor = cut === -1 ? '' : decode(raw.slice(cut + 1))
  return { path: path || null, anchor }
}

export function hashFor(path: string, anchor?: string): string {
  const p = path.split('/').map(encodeURIComponent).join('/')
  return `#/${p}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`
}
