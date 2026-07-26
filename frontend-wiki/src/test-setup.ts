// Node 26 объявляет собственный глобальный localStorage, и без --localstorage-file
// его геттер отдаёт undefined, перекрывая jsdom-овский. Кладём на его место
// простое хранилище в памяти — тестам этого достаточно.
if (!globalThis.localStorage) {
  const data = new Map<string, string>()
  const storage: Storage = {
    get length() { return data.size },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, String(v)) },
    removeItem: (k: string) => { data.delete(k) },
    clear: () => { data.clear() },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
}
