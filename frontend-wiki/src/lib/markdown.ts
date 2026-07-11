import { marked } from 'marked'
import hljs from 'highlight.js'
import 'highlight.js/styles/github.css'

const renderer = new marked.Renderer()

renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const validLang = lang && hljs.getLanguage(lang)
  const highlighted = validLang
    ? hljs.highlight(text, { language: lang! }).value
    : hljs.highlightAuto(text).value
  return `<pre><code class="hljs language-${lang || ''}">${highlighted}</code></pre>`
}

marked.use({
  renderer,
  breaks: true,
  gfm: true,
})

export function renderMarkdown(text: string): string {
  return marked.parse(text) as string
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

export function enhanceCodeBlocks(container: HTMLElement): void {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-header')) return
    const code = pre.querySelector('code')
    const lang = code?.className?.match(/language-(\w+)/)?.[1] || ''

    const header = document.createElement('div')
    header.className = 'code-header'
    header.innerHTML = `<span class="code-lang">${escapeHtml(lang)}</span><button class="copy-btn">Скопировать</button>`
    header.querySelector('.copy-btn')!.addEventListener('click', function (this: HTMLButtonElement) {
      navigator.clipboard.writeText(code ? code.textContent! : pre.textContent!)
      this.textContent = 'Скопировано'
      this.classList.add('copied')
      setTimeout(() => {
        this.textContent = 'Скопировать'
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
    header.innerHTML = '<span class="code-lang">table</span><button class="copy-btn">Скопировать</button>'
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
      this.textContent = 'Скопировано'
      this.classList.add('copied')
      setTimeout(() => {
        this.textContent = 'Скопировать'
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
