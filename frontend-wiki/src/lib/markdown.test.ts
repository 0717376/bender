import { describe, expect, it } from 'vitest'
import { markLinks, renderMarkdown, resolveWikiPath, slugify, toggleTask } from './markdown'

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
    markLinks(root, 'index.md', new Set(['index.md']), 'нет такой')
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
    markLinks(root, 'index.md', new Set(['index.md']), 'нет такой')
    markLinks(root, 'index.md', new Set(['index.md', 'есть.md']), 'нет такой')
    const a = root.querySelector('a')!
    expect(a.dataset.dead).toBeUndefined()
    expect(a.hasAttribute('title')).toBe(false)
  })

  it('внешние ссылки открывает в новой вкладке', () => {
    const root = render('<a href="https://example.com">тык</a>')
    markLinks(root, 'index.md', new Set(), 'нет такой')
    const a = root.querySelector('a')!
    expect(a.dataset.ext).toBe('')
    expect(a.target).toBe('_blank')
    expect(a.dataset.dead).toBeUndefined()
  })

  it('не трогает якоря и ссылки в хранилище', () => {
    const root = render('<a href="#раздел">я</a><a href="storage:Док/скан.pdf">файл</a>')
    markLinks(root, 'index.md', new Set(), 'нет такой')
    root.querySelectorAll('a').forEach(a => expect(a.dataset.dead).toBeUndefined())
  })
})
