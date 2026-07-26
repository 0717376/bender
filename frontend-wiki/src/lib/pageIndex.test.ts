import { describe, expect, it } from 'vitest'
import type { FileNode } from './types'
import { buildIndex, normalizeTree, pageLabel } from './pageIndex'

const page = (path: string, title?: string): FileNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'file',
  title,
})

// Папка с index.md приезжает с бэкенда как узел-страница: path — папка, page — её index.md.
const parent = (path: string, title: string, children: FileNode[]): FileNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'dir',
  page: `${path}/index.md`,
  title,
  children,
})

// Так дерево и приезжает в приложение: fetchTree прогоняет его через normalizeTree.
const tree: FileNode[] = normalizeTree([
  parent('infra', 'Инфраструктура', [
    parent('infra/machines', 'Машины', [
      page('infra/machines/hermes.md', 'Hermes'),
      page('infra/machines/litellm.md', 'LiteLLM'),
    ]),
    page('infra/home-network.md', 'Домашняя сеть'),
  ]),
  page('litellm.md', 'LiteLLM'),
])

describe('pageLabel', () => {
  it('у родительской страницы имя берёт от папки, а не от index', () => {
    expect(pageLabel('infra/machines/index.md')).toBe('machines')
    expect(pageLabel('infra/hermes.md')).toBe('hermes')
    expect(pageLabel('index.md')).toBe('index')
  })
})

describe('buildIndex', () => {
  const index = buildIndex(tree)

  it('знает и обычные страницы, и родительские', () => {
    expect(index.paths.has('infra/machines/hermes.md')).toBe(true)
    expect(index.paths.has('infra/machines/index.md')).toBe(true)
  })

  it('находит страницу по имени файла', () => {
    expect(index.resolve('hermes', null)).toBe('infra/machines/hermes.md')
  })

  it('находит по заголовку и не смотрит на регистр', () => {
    expect(index.resolve('Домашняя сеть', null)).toBe('infra/home-network.md')
    expect(index.resolve('домашняя сеть', null)).toBe('infra/home-network.md')
  })

  it('родительская страница ищется по имени папки, а не по index', () => {
    expect(index.resolve('machines', null)).toBe('infra/machines/index.md')
    expect(index.resolve('Машины', null)).toBe('infra/machines/index.md')
  })

  it('однофамильцев разводит по близости к текущей странице', () => {
    expect(index.resolve('litellm', 'infra/machines/hermes.md')).toBe('infra/machines/litellm.md')
    expect(index.resolve('litellm', 'index.md')).toBe('litellm.md')
  })

  it('понимает и путь целиком', () => {
    expect(index.resolve('infra/machines/hermes.md', null)).toBe('infra/machines/hermes.md')
    expect(index.resolve('infra/machines', null)).toBe('infra/machines/index.md')
  })

  it('на неизвестное имя отвечает null', () => {
    expect(index.resolve('нетути', null)).toBeNull()
  })
})
