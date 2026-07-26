import { beforeEach, describe, expect, it } from 'vitest'
import { hashFor, parseHash } from './route'

const go = (hash: string) => { location.hash = hash }

describe('route', () => {
  beforeEach(() => { location.hash = '' })

  it('читает путь и якорь', () => {
    go('#/infra/machines/hermes.md#docker')
    expect(parseHash()).toEqual({ path: 'infra/machines/hermes.md', anchor: 'docker' })
  })

  it('без якоря отдаёт пустую строку', () => {
    go('#/index.md')
    expect(parseHash()).toEqual({ path: 'index.md', anchor: '' })
  })

  it('чужой хеш игнорирует', () => {
    go('#today')
    expect(parseHash().path).toBeNull()
  })

  it('кириллица и пробелы переживают круг', () => {
    const path = 'Домашняя сеть/План Б.md'
    const anchor = 'что-делать'
    go(hashFor(path, anchor))
    expect(parseHash()).toEqual({ path, anchor })
  })

  it('кодирует по сегментам, слэши остаются слэшами', () => {
    expect(hashFor('a b/c.md')).toBe('#/a%20b/c.md')
  })
})
