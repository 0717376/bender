import type { FileNode } from './types'
import { slugify } from './markdown'

// Указатель страниц: пути (чтобы отличать живые ссылки от битых) и имена — чтобы
// `[[litellm]]` находил страницу, где бы она ни лежала. Именно это делает переезд
// страницы между родителями бесплатным: ссылки не знают её пути.
export interface PageIndex {
  paths: Set<string>
  resolve(name: string, from: string | null): string | null
}

const key = (raw: string) => slugify(raw.replace(/\.md$/i, ''))
const baseOf = (p: string) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p)

/** Человеческое имя страницы по её пути — когда заголовка ещё нет под рукой.
 *  Родительская страница живёт в index.md своей папки, и «index» показывать нельзя. */
export function pageLabel(path: string): string {
  const base = baseOf(path).replace(/\.md$/i, '')
  if (base !== 'index' || !path.includes('/')) return base
  return baseOf(path.slice(0, path.lastIndexOf('/')))
}

// Насколько кандидат «близок» к странице, с которой на него ссылаются: сначала общие
// папки, потом — кто ближе к корню. Однофамильцы разрешаются в пользу соседа.
function nearest(candidates: string[], from: string | null): string {
  const here = (from ?? '').split('/').slice(0, -1)
  let best = candidates[0]
  let bestScore = -1
  for (const path of candidates) {
    const dirs = path.split('/').slice(0, -1)
    let shared = 0
    while (shared < here.length && shared < dirs.length && here[shared] === dirs[shared]) shared++
    const score = shared * 100 - dirs.length
    if (score > bestScore) { bestScore = score; best = path }
  }
  return best
}

/** Узел — страница тогда и только тогда, когда у него есть page. Бэкенд ставит его
 *  папкам с index.md; обычным файлам его дописываем здесь, и дальше по коду разницы
 *  между «страницей» и «страницей с детьми» нет нигде. */
export function normalizeTree(nodes: FileNode[]): FileNode[] {
  for (const node of nodes) {
    if (!node.page && node.type === 'file') node.page = node.path
    if (node.children) normalizeTree(node.children)
  }
  return nodes
}

export function buildIndex(tree: FileNode[]): PageIndex {
  const paths = new Set<string>()
  const byName = new Map<string, string[]>()

  const add = (name: string, page: string) => {
    const k = key(name)
    if (!k) return
    const list = byName.get(k)
    if (!list) byName.set(k, [page])
    else if (!list.includes(page)) list.push(page)
  }

  const walk = (nodes: FileNode[]) => {
    for (const node of nodes) {
      paths.add(node.path)
      if (node.page) {
        paths.add(node.page)
        // Имя узла, а не файла: у страницы с детьми это папка, а не её index.md.
        add(baseOf(node.path), node.page)
        if (node.title) add(node.title, node.page)
      }
      if (node.children) walk(node.children)
    }
  }
  walk(tree)

  return {
    paths,
    resolve(name, from) {
      const raw = name.trim().replace(/^\/+/, '')
      if (!raw) return null
      if (raw.includes('/') || /\.md$/i.test(raw)) {
        // Папка-родитель проверяется первой: путь `infra/machines` — это её страница.
        for (const cand of [`${raw}/index.md`, raw, `${raw}.md`]) {
          if (cand.endsWith('.md') && paths.has(cand)) return cand
        }
      }
      const list = byName.get(key(raw))
      if (!list?.length) return null
      return list.length === 1 ? list[0] : nearest(list, from)
    },
  }
}
