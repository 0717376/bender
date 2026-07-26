import { describe, expect, it } from 'vitest'
import { markLinks, renderMarkdown, resolveWikiPath, slugify, toggleTask } from './markdown'
import type { PageIndex } from './pageIndex'

// Указатель страниц с разрешением по имени файла — большего этим тестам не нужно.
const index = (...paths: string[]): PageIndex => ({
  paths: new Set(paths),
  resolve: (name) =>
    paths.find(p => p === name || p === `${name}.md` || p.endsWith(`/${name}.md`)) ?? null,
})

describe('slugify', () => {
  it('делает якорь из кириллицы', () => {
    expect(slugify('Домашняя сеть')).toBe('домашняя-сеть')
    expect(slugify('Docker и сервисы')).toBe('docker-и-сервисы')
  })

  it('срезает знаки по краям и не оставляет пустоту', () => {
    expect(slugify('## Бэкапы!')).toBe('бэкапы')
    expect(slugify('—')).toBe('section')
  })
})

describe('renderMarkdown', () => {
  it('проставляет id заголовкам и разводит одинаковые', () => {
    const html = renderMarkdown('## Итоги\n\n## Итоги\n')
    expect(html).toContain('id="итоги"')
    expect(html).toContain('id="итоги-2"')
  })

  it('нумерация якорей не течёт между страницами', () => {
    renderMarkdown('## Итоги\n')
    expect(renderMarkdown('## Итоги\n')).toContain('id="итоги"')
  })
})

describe('resolveWikiPath', () => {
  it('считает путь относительно открытой страницы', () => {
    expect(resolveWikiPath('infra/machines/hermes.md', 'nas.md')).toBe('infra/machines/nas.md')
    expect(resolveWikiPath('infra/machines/hermes.md', '../home-network.md')).toBe('infra/home-network.md')
    expect(resolveWikiPath('infra/machines/hermes.md', '/index.md')).toBe('index.md')
  })

  it('внешние ссылки и якоря не трогает', () => {
    expect(resolveWikiPath('a.md', 'https://example.com')).toBeNull()
    expect(resolveWikiPath('a.md', 'mailto:me@example.com')).toBeNull()
    expect(resolveWikiPath('a.md', '#раздел')).toBeNull()
  })

  it('отбрасывает якорь и понимает проценты', () => {
    expect(resolveWikiPath('a/b.md', 'c.md#раздел')).toBe('a/c.md')
    expect(resolveWikiPath('', '%D0%B4%D0%BE%D0%BC.md')).toBe('дом.md')
  })
})

describe('toggleTask', () => {
  const doc = '- [ ] первая\n- [x] вторая\n\n```\n- [ ] в коде\n```\n\n- [ ] третья\n'

  it('переключает нужный по счёту пункт', () => {
    expect(toggleTask(doc, 0)!.split('\n')[0]).toBe('- [x] первая')
    expect(toggleTask(doc, 1)!.split('\n')[1]).toBe('- [ ] вторая')
  })

  it('не считает пункты внутри ``` — там задачи не рендерятся', () => {
    const out = toggleTask(doc, 2)!
    expect(out).toContain('- [ ] в коде')
    expect(out.trimEnd().endsWith('- [x] третья')).toBe(true)
  })

  it('возвращает null, если такого пункта нет', () => {
    expect(toggleTask(doc, 9)).toBeNull()
  })
})

describe('markLinks', () => {
  const render = (html: string) => {
    const root = document.createElement('div')
    root.innerHTML = html
    return root
  }

  it('помечает ссылку на несуществующую страницу', () => {
    const root = render('<a href="нет.md">нет</a>')
    markLinks(root, 'index.md', index('index.md'), 'нет такой')
    const a = root.querySelector('a')!
    expect(a.dataset.dead).toBe('')
    expect(a.title).toBe('нет такой')
  })

  it('до загрузки дерева не судит ссылки', () => {
    const root = render('<a href="нет.md">нет</a>')
    markLinks(root, 'index.md', null, 'нет такой')
    expect(root.querySelector('a')!.dataset.dead).toBeUndefined()
  })

  it('снимает пометку, когда страница появилась', () => {
    const root = render('<a href="есть.md">есть</a>')
    markLinks(root, 'index.md', index('index.md'), 'нет такой')
    markLinks(root, 'index.md', index('index.md', 'есть.md'), 'нет такой')
    const a = root.querySelector('a')!
    expect(a.dataset.dead).toBeUndefined()
    expect(a.hasAttribute('title')).toBe(false)
  })

  it('внешние ссылки открывает в новой вкладке', () => {
    const root = render('<a href="https://example.com">тык</a>')
    markLinks(root, 'index.md', index(), 'нет такой')
    const a = root.querySelector('a')!
    expect(a.dataset.ext).toBe('')
    expect(a.target).toBe('_blank')
    expect(a.dataset.dead).toBeUndefined()
  })

  it('не трогает якоря и ссылки в хранилище', () => {
    const root = render('<a href="#раздел">я</a><a href="storage:Док/скан.pdf">файл</a>')
    markLinks(root, 'index.md', index(), 'нет такой')
    root.querySelectorAll('a').forEach(a => expect(a.dataset.dead).toBeUndefined())
  })
})

describe('ссылки по имени', () => {
  const doc = (md: string) => {
    const root = document.createElement('div')
    root.innerHTML = renderMarkdown(md)
    return root
  }

  it('подставляет адрес найденной страницы', () => {
    const root = doc('см. [[litellm]]')
    markLinks(root, 'infra/index.md', index('infra/litellm.md'), 'нет такой')
    const a = root.querySelector('a')!
    expect(a.getAttribute('href')).toBe('/infra/litellm.md')
    expect(a.textContent).toBe('litellm')
    expect(a.dataset.dead).toBeUndefined()
  })

  it('уважает подпись и якорь', () => {
    const root = doc('[[litellm#доступ|наш прокси]]')
    markLinks(root, 'index.md', index('litellm.md'), 'нет такой')
    const a = root.querySelector('a')!
    expect(a.textContent).toBe('наш прокси')
    expect(a.getAttribute('href')).toBe('/litellm.md#' + encodeURIComponent('доступ'))
  })

  it('помечает битой, когда такой страницы нет', () => {
    const root = doc('[[нетути]]')
    markLinks(root, 'index.md', index('index.md'), 'нет такой')
    expect(root.querySelector('a')!.dataset.dead).toBe('')
  })

  it('оживает, когда страница появилась', () => {
    const root = doc('[[litellm]]')
    markLinks(root, 'index.md', index('index.md'), 'нет такой')
    markLinks(root, 'index.md', index('index.md', 'litellm.md'), 'нет такой')
    const a = root.querySelector('a')!
    expect(a.dataset.dead).toBeUndefined()
    expect(a.getAttribute('href')).toBe('/litellm.md')
  })

  it('внутри кода остаётся текстом', () => {
    const root = doc('`[[litellm]]` и\n\n```\n[[kuma]]\n```\n')
    expect(root.querySelectorAll('a')).toHaveLength(0)
    expect(root.textContent).toContain('[[litellm]]')
    expect(root.textContent).toContain('[[kuma]]')
  })
})
