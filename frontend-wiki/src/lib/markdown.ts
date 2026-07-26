import { marked, type Tokens } from 'marked'
import hljs from 'highlight.js'
import 'highlight.js/styles/github.css'
import { t } from './i18n'

const renderer = new marked.Renderer()

renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const validLang = lang && hljs.getLanguage(lang)
  const highlighted = validLang
    ? hljs.highlight(text, { language: lang! }).value
    : hljs.highlightAuto(text).value
  return `<pre><code class="hljs language-${lang || ''}">${highlighted}</code></pre>`
}

// Якорь заголовка: marked сам id не проставляет, а без него нет ни оглавления,
// ни ссылок вида `страница.md#раздел`.
const slugSeen = new Map<string, number>()

export function slugify(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'section'
}

renderer.heading = function (token: Tokens.Heading) {
  const html = this.parser.parseInline(token.tokens)
  const base = slugify(token.text)
  const n = (slugSeen.get(base) ?? 0) + 1
  slugSeen.set(base, n)
  return `<h${token.depth} id="${n === 1 ? base : `${base}-${n}`}">${html}</h${token.depth}>`
}

marked.use({
  renderer,
  breaks: true,
  gfm: true,
})

export function renderMarkdown(text: string): string {
  slugSeen.clear()
  return marked.parse(text) as string
}

export interface Heading {
  id: string
  text: string
  level: number
}

export function collectHeadings(root: HTMLElement): Heading[] {
  return Array.from(root.querySelectorAll<HTMLElement>('h2, h3')).map(el => ({
    id: el.id,
    text: el.textContent?.trim() || '',
    level: el.tagName === 'H2' ? 2 : 3,
  }))
}

// Resolve a relative markdown link (href) against the currently open file's path.
// Returns the wiki path (relative to content root) for internal links, or null
// for external links (http(s)://, mailto:, etc.) and pure anchors (#...).
export function resolveWikiPath(currentPath: string | null, href: string): string | null {
  if (!href) return null
  // External, protocol-relative, or in-page anchor — let the browser handle it.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) {
    return null
  }
  // Drop any query/hash fragment.
  const clean = href.replace(/[?#].*$/, '')
  if (!clean) return null

  let decoded = clean
  try { decoded = decodeURIComponent(clean) } catch { /* keep raw */ }

  // Absolute (from content root) vs relative to current file's directory.
  const baseParts = decoded.startsWith('/')
    ? []
    : (currentPath ?? '').split('/').slice(0, -1)

  const parts = baseParts.slice()
  for (const seg of decoded.replace(/^\//, '').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

export function escapeHtml(str: string): string {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}

// Внутренние ссылки помечаем «битыми», если такой страницы нет в дереве, внешние —
// стрелкой. Обработку кликов делает ContentPane, здесь только разметка.
export function markLinks(
  root: HTMLElement,
  currentPath: string | null,
  exists: (path: string) => boolean,
  missingLabel: string,
): void {
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(a => {
    const href = a.getAttribute('href') || ''
    if (href.startsWith('storage:') || href.startsWith('#')) return
    const target = resolveWikiPath(currentPath, href)
    if (target === null) {
      a.dataset.ext = ''
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      return
    }
    if (target && !exists(target)) {
      a.dataset.dead = ''
      a.title = missingLabel
    }
  })
}

// Переключить n-й чекбокс в исходнике (порядок совпадает с порядком рендера;
// строки внутри ``` пропускаем — там задачи не рендерятся).
export function toggleTask(text: string, index: number): string | null {
  const lines = text.split('\n')
  let fenced = false
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const m = lines[i].match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/)
    if (!m) continue
    if (n === index) {
      const at = m[1].length
      lines[i] = lines[i].slice(0, at) + (m[2] === ' ' ? 'x' : ' ') + lines[i].slice(at + 1)
      return lines.join('\n')
    }
    n++
  }
  return null
}

export function enhanceCodeBlocks(container: HTMLElement): void {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-header')) return
    const code = pre.querySelector('code')
    const lang = code?.className?.match(/language-(\w+)/)?.[1] || ''

    const header = document.createElement('div')
    header.className = 'code-header'
    header.innerHTML = `<span class="code-lang">${escapeHtml(lang)}</span><button class="copy-btn">${t('copy')}</button>`
    header.querySelector('.copy-btn')!.addEventListener('click', function (this: HTMLButtonElement) {
      navigator.clipboard.writeText(code ? code.textContent! : pre.textContent!)
      this.textContent = t('copied')
      this.classList.add('copied')
      setTimeout(() => {
        this.textContent = t('copy')
        this.classList.remove('copied')
      }, 1500)
    })
    pre.insertBefore(header, pre.firstChild)
  })

  container.querySelectorAll('table').forEach(table => {
    if (table.parentElement?.classList.contains('table-wrap')) return

    const wrap = document.createElement('div')
    wrap.className = 'table-wrap'
    table.parentNode!.insertBefore(wrap, table)

    const header = document.createElement('div')
    header.className = 'code-header'
    header.innerHTML = `<span class="code-lang">table</span><button class="copy-btn">${t('copy')}</button>`
    header.querySelector('.copy-btn')!.addEventListener('click', function (this: HTMLButtonElement) {
      const headerCells: string[] = []
      table.querySelectorAll('thead th').forEach(th => headerCells.push(th.textContent!.trim()))
      const rows: string[] = []
      if (headerCells.length) {
        rows.push('| ' + headerCells.join(' | ') + ' |')
        rows.push('| ' + headerCells.map(() => '---').join(' | ') + ' |')
      }
      table.querySelectorAll('tbody tr').forEach(tr => {
        const cells: string[] = []
        tr.querySelectorAll('td, th').forEach(cell => cells.push(cell.textContent!.trim()))
        rows.push('| ' + cells.join(' | ') + ' |')
      })
      navigator.clipboard.writeText(rows.join('\n'))
      this.textContent = t('copied')
      this.classList.add('copied')
      setTimeout(() => {
        this.textContent = t('copy')
        this.classList.remove('copied')
      }, 1500)
    })

    const scroll = document.createElement('div')
    scroll.className = 'table-scroll'
    scroll.appendChild(table)
    wrap.appendChild(header)
    wrap.appendChild(scroll)
  })
}
