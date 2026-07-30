import { mkdirSync } from 'node:fs'
import { webkit, devices } from 'playwright'
import { build, preview } from 'vite'
import { makeEpub, COVER, FIXTURE } from './fixtures/epub.mjs'

/* Проверяем собранное приложение, а не исходники: собираем и поднимаем превью сами. */
const ROOT = new URL('..', import.meta.url).pathname
const shot = n => new URL('shots/' + n + '.png', import.meta.url).pathname
mkdirSync(new URL('shots/', import.meta.url), { recursive: true })
await build({ root: ROOT, logLevel: 'warn' })
const server = await preview({ root: ROOT, preview: { host: '127.0.0.1', port: 8898, strictPort: true } })
const URL_ = 'http://127.0.0.1:8898/index.html'
const BOOK = await makeEpub()
const ok = [], bad = []
const check = (name, cond, extra = '') => (cond ? ok : bad).push(name + (extra ? ` — ${extra}` : ''))

/* Бэкенд агента живёт на вики и требует пароля — в тесте подменяем и вход, и сокет:
   проверяем свою половину протокола, а не чужой сервер. */
const STUB = () => {
  window.__sent = []
  class FakeWS {
    constructor(url) {
      window.__wsUrl = url
      this.readyState = 0
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}) }, 20)
    }
    send(data) {
      window.__sent.push(JSON.parse(data))
      const steps = [
        { t: 'tool', name: 'Grep', pattern: 'сложность' },
        { t: 'text', id: 'm1', text: 'Автор' },
        { t: 'text', id: 'm1', text: 'Автор говорит о **сложности**.\n\n- накапливается по мелочи\n- убирается тоже по мелочи' },
        { t: 'done', sid: 's1' },
      ]
      steps.forEach((s, i) => setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(s) }), 70 * (i + 1)))
    }
    close() { this.readyState = 3; this.onclose && this.onclose({ code: 1000 }) }
  }
  window.WebSocket = FakeWS
}

/* Подставной сервер состояния: та же склейка, что в books.db — побеждает более позднее,
   удаление живёт надгробием. Один на все контексты: так проверяется, что прогресс переезжает. */
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
const srv = { pos: {}, hl: {} }
let pushes = 0, states = 0

/* Подставная библиотека: одна на все контексты — как настоящая на сервере. */
let library = [], thumbs = [], thumbBytes = null
let liveTick = null            // что отдаст поток событий при следующем подключении
const beats = []               // отметки «сколько читали», как их шлёт устройство
/* Статистика: сервер считает сам, поэтому здесь — заранее известный ответ. Дни задаём
   относительно того дня, который прислало устройство: тест не должен падать в полночь. */
const statsBody = today => {
  const back = n => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - n)
    const p = x => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
  const days = [
    { day: back(40), secs: 300, pct: 0.01, highlights: 0 },
    { day: back(1), secs: 2400, pct: 0.05, highlights: 2 },
    { day: back(0), secs: 900, pct: 0.02, highlights: 0 },
  ]
  return { today, from: back(181), days,
    books: [{ id: BOOK_ID, title: FIXTURE.title, author: FIXTURE.author, secs: 3600, pct: 0.08,
              days: 3, highlights: 2, at: 0.31 }],
    totals: { secs: 3600, days: 3, highlights: 2, streak: 2, best: 2, longest_day: 2400 } }
}
const BOOK_ID = 'bk1test'
const booksRoute = async r => {
  const req = r.request()
  const path = new URL(req.url()).pathname
  const json = body => r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) })
  /* Поток живой синхронизации. Держать соединение открытым route не умеет, поэтому
     отдаём накопленное событие и закрываемся — EventSource переподключится сам. */
  if (path === '/books/events') {
    return r.fulfill({ status: 200, headers: CORS, contentType: 'text/event-stream',
                       body: liveTick ? `event: books\ndata: ${JSON.stringify(liveTick)}\n\n` : '' })
  }
  if (path === '/books/stats') return json(statsBody(new URL(req.url()).searchParams.get('today')))
  const m = path.match(/^\/books(?:\/([^/]+))?(?:\/(file|cover|thumb|state|highlights|position|read))?$/)
  if (!m) return r.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{"detail":"нет"}' })
  const [, id, kind] = m

  if (req.method() === 'POST' && kind === 'read') {
    beats.push(JSON.parse(req.postData() || '{}'))
    return json({ ok: true })
  }
  if (req.method() === 'POST') {
    const meta = { id: BOOK_ID, title: FIXTURE.title, author: FIXTURE.author,
                   added: Math.round(Date.now() / 1000), size: BOOK.length,
                   chapters: FIXTURE.chapters.length, cover: 'cover.png', thumb: '' }
    if (library.find(b => b.id === meta.id)) return json({ ...meta, known: true })
    library.push(meta)
    return json(meta)
  }
  if (req.method() === 'DELETE') { library = library.filter(b => b.id !== id); return json({ ok: true }) }
  if (req.method() === 'PUT' && kind === 'thumb') {
    const body = req.postDataBuffer()
    thumbs.push({ id, bytes: body ? body.length : 0, jpeg: !!body && body[0] === 0xff && body[1] === 0xd8 })
    thumbBytes = body
    const b = library.find(x => x.id === id)
    if (b) b.thumb = 'thumb.jpg'
    return json(b || { thumb: 'thumb.jpg' })
  }
  // Склейка как на сервере: побеждает более позднее, удаление живёт надгробием.
  if (req.method() === 'PUT' && kind === 'highlights') {
    pushes++
    const box = srv.hl[id] || (srv.hl[id] = {})
    for (const h of JSON.parse(req.postData() || '[]')) {
      const cur = box[h.id]
      if (!cur || (cur.updated || 0) <= (h.updated || 0)) box[h.id] = h
    }
    return json(Object.values(box))
  }
  if (req.method() === 'PUT' && kind === 'position') {
    const p = JSON.parse(req.postData() || '{}')
    const cur = srv.pos[id]
    if (!cur || (cur.updated || 0) <= (p.updated || 0)) srv.pos[id] = { ...p, updated: p.updated || Date.now() }
    return json(srv.pos[id])
  }
  if (kind === 'state') {
    states++
    return json({ position: srv.pos[id] || null, highlights: Object.values(srv.hl[id] || {}) })
  }
  if (kind === 'file') return r.fulfill({ status: 200, headers: CORS, contentType: 'application/epub+zip', body: BOOK })
  if (kind === 'cover') return r.fulfill({ status: 200, headers: CORS, contentType: 'image/png', body: COVER })
  if (kind === 'thumb') return thumbBytes
    ? r.fulfill({ status: 200, headers: CORS, contentType: 'image/jpeg', body: thumbBytes })
    : r.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{"detail":"нет"}' })
  return json(library.map(b => ({
    ...b,
    position: srv.pos[b.id] || null,
    highlights: Object.values(srv.hl[b.id] || {}).filter(h => !h.deleted).length,
  })))
}

const browser = await webkit.launch()
const ctx = await browser.newContext({ ...devices['iPhone 13'], hasTouch: false })
await ctx.route('**/auth/login', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"token":"T"}' }))
await ctx.route('**/auth/me', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
await ctx.route('**/books', booksRoute)
await ctx.route('**/books/**', booksRoute)
await ctx.addInitScript(STUB)
const page = await ctx.newPage()
page.on('pageerror', e => console.log('  [pageerror]', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200)) })

const F = (p = page) => p.frames().find(f => f !== p.mainFrame())

async function selectByDrag(p = page) {
  await p.evaluate(() => { closeSheet(); closeDrawer() })
  await p.waitForTimeout(250)
  const pt = await p.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight
    const frame = document.querySelector('#viewer iframe')
    const doc = frame.contentDocument, fr = frame.getBoundingClientRect()
    const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walk.nextNode())) {
      if (node.textContent.trim().length < 60) continue
      const r = doc.createRange(); r.setStart(node, 3); r.setEnd(node, 40)
      const bb = r.getClientRects()[0]
      if (!bb || bb.width < 30) continue
      const x1 = fr.left + bb.left + 4, x2 = fr.left + bb.right - 4, y = fr.top + bb.top + bb.height / 2
      if (x1 > 16 && x2 < vw - 16 && y > 70 && y < vh - 70) return { x1, x2, y }
    }
    return null
  })
  if (!pt) return null
  await p.mouse.move(pt.x1, pt.y)
  await p.mouse.down()
  for (let i = 1; i <= 6; i++) { await p.mouse.move(pt.x1 + (pt.x2 - pt.x1) * i / 6, pt.y); await p.waitForTimeout(35) }
  await p.mouse.up()
  await p.waitForSelector('#selbar.on', { timeout: 6000 }).catch(() => {})
  return p.evaluate(() => state.pending?.text || null)
}

/* Модули ничего не кладут в window — приложение отдаёт один набор функций для проверок. */
const expose = p => p.evaluate(() => Object.assign(window, window.__books))

/** Положить книгу на полку так же, как это делает человек: через выбор файла. */
async function addBook(p) {
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('#btnAdd')])
  await chooser.setFiles({ name: 'fixture.epub', mimeType: 'application/epub+zip', buffer: BOOK })
  await p.waitForSelector('#reader.on', { timeout: 30000 })
  await p.waitForFunction(() => !!document.querySelector('#viewer iframe'), null, { timeout: 30000 })
}

/** Середина нарисованной выписки в координатах окна — по ней и тыкаем. */
const markCenter = p => p.evaluate(() => {
  for (const g of document.querySelectorAll('#viewer svg g[data-id]')) {
    const b = g.children[0].getBoundingClientRect()
    // Соседние колонки книги живут за краем экрана — метки оттуда тапать бессмысленно.
    if (b.width > 8 && b.top > 70 && b.bottom < window.innerHeight - 140
        && b.left > 8 && b.right < window.innerWidth - 8)
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), id: g.dataset.id }
  }
  return null
})

/** Выделить и закрасить теми же helpers, что зовёт палец: без жестов, но по тому же пути. */
const paintAt = p => p.evaluate(() => {
  const contents = state.rendition.getContents()[0]
  const doc = contents.document
  const fr = document.querySelector('#viewer iframe').getBoundingClientRect()
  const vb = document.querySelector('#viewer').getBoundingClientRect()
  for (let k = 0.3; k < 0.8; k += 0.05) {
    const y = vb.top + vb.height * k
    const a = wordAt(doc, vb.left + vb.width * 0.22 - fr.left, y - fr.top)
    const f = caretAt(doc, vb.left + vb.width * 0.62 - fr.left, y - fr.top)
    if (!a || !f) continue
    sel.on = true; sel.contents = contents; sel.anchor = a; sel.focus = f
    commitSel()
    if (!state.pending || !state.pending.text) continue
    const t = state.pending.text
    paint('imp')
    return t
  }
  return null
})

const toProse = p => p.evaluate(async () => {
  for (const item of state.book.spine.spineItems.slice(0, 24)) {
    await state.rendition.display(item.href)
    await new Promise(r => setTimeout(r, 140))
    const doc = document.querySelector('#viewer iframe').contentDocument
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = w.nextNode())) if (node.textContent.trim().length > 200) return item.href
  }
  return null
})

// 1. Вход
await page.goto(URL_)
await page.waitForSelector('#auth.on')
await expose(page)
check('вход: экран пароля показан', true)
await page.fill('#authPass', 'secret')
await page.click('#authGo')
await page.waitForSelector('#shelf.on', { timeout: 15000 })
check('вход: после пароля открылась полка', true)
check('вход: токен сохранён', await page.evaluate(() => !!JSON.parse(localStorage.getItem('token'))))

// 2. Полка: книга приходит импортом — встроенной в сборке нет
check('полка: пустая до импорта', await page.locator('.card').count() === 1)
await addBook(page)
check('импорт: книга открылась сразу после добавления', await page.locator('#reader.on').count() === 1)
await page.evaluate(() => closeBook())
await page.waitForSelector('#shelf.on')
await page.waitForFunction(() => {
  const i = document.querySelector('.card .cover-wrap img')
  return i && i.src && i.naturalWidth > 0
}, null, { timeout: 40000 })
const shelf = await page.evaluate(() => {
  const c = document.querySelector('.card')
  return { title: c.querySelector('.t').textContent, author: c.querySelector('.a').textContent,
           cards: document.querySelectorAll('.card').length }
})
check('полка: книга с обложкой и названием', shelf.title === FIXTURE.title && shelf.author === FIXTURE.author,
  `${shelf.title} / ${shelf.author}`)
check('полка: есть плитка «Добавить»', shelf.cards === 2)
// Миниатюра делается в фоне, не задерживая книгу, — дожидаемся её обновлением полки.
await page.evaluate(() => refreshShelf())
const shownThumb = await page.waitForFunction(() => {
  const i = document.querySelector('.card .cover-wrap img')
  return i && /\/thumb\?token=/.test(i.src) && i.naturalWidth > 0
}, null, { timeout: 15000 }).then(() => true).catch(() => false)
check('обложка: клиент уменьшил и отправил на сервер',
  thumbs.length === 1 && thumbs[0].jpeg && thumbs[0].bytes > 0 && thumbs[0].bytes < 60000,
  thumbs.length ? `${thumbs[0].bytes} байт, jpeg: ${thumbs[0].jpeg}` : 'ничего не отправлено')
check('полка: показывает миниатюру, а не оригинал', shownThumb)
await page.screenshot({ path: shot('shelf') })

// 3. Читалка
await page.locator('.card').first().click()
await page.waitForSelector('#reader.on')
await page.waitForFunction(() => !!document.querySelector('#viewer iframe'), null, { timeout: 30000 })
const landed = await page.evaluate(async () => {
  for (const item of state.book.spine.spineItems.slice(0, 24)) {
    await state.rendition.display(item.href)
    await new Promise(r => setTimeout(r, 140))
    const doc = document.querySelector('#viewer iframe').contentDocument
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = w.nextNode())) if (node.textContent.trim().length > 200) return item.href
  }
  return null
})
check('читалка: доехали до текста', !!landed, landed || '')
// Отходим от самого начала: полке нужна ненулевая доля прочитанного, чтобы показать «Продолжить».
await page.evaluate(async () => {
  await state.rendition.next(); await state.rendition.next()
  await new Promise(r => setTimeout(r, 300))
})
await page.waitForTimeout(900)
const bot = await page.evaluate(() => ({
  chap: document.querySelector('#chapLabel').textContent,
  page: document.querySelector('#pageInfo').textContent,
}))
check('читалка: глава и страница в полосе', !!bot.chap && /из/.test(bot.page), `${bot.chap} · ${bot.page}`)

// 4. Выделение → агент
const picked = await selectByDrag()
check('выделение: панель показана', await page.locator('#selbar').evaluate(n => n.classList.contains('on')),
  JSON.stringify((picked || '').slice(0, 40)))
await page.locator('#selActs .act', { hasText: 'Объяснить' }).click()
await page.waitForSelector('#sheet.on')
await page.waitForTimeout(500)
const sent = await page.evaluate(() => window.__sent[0])
check('агент: сокет с токеном и surface', /token=T&surface=books/.test(await page.evaluate(() => window.__wsUrl)))
check('агент: в контексте id книги и глава', sent && !!(sent.context.book || {}).id && !!sent.context.book.chapter,
  sent ? JSON.stringify(sent.context.book) : 'нет')
check('агент: в запрос ушла цитата', sent && sent.text.includes(picked.slice(0, 30)))
check('агент: в запрос ушёл контекст вокруг', sent && /Текст вокруг/.test(sent.text) && sent.text.length > picked.length + 400,
  `длина запроса ${sent ? sent.text.length : 0} симв.`)
check('агент: контекст книги в запросе', sent && sent.text.includes('Я читаю книгу «' + FIXTURE.title))
await page.waitForTimeout(700)
const answer = await page.evaluate(() => {
  const n = document.querySelector('#sheetBody .ai')
  return { html: n ? n.innerHTML : '', tool: !!document.querySelector('#sheetBody .tool') }
})
check('агент: ответ отрисован с разметкой', /<b>сложности<\/b>/.test(answer.html) && /<ul>/.test(answer.html))
await page.screenshot({ path: shot('sheet') })

// 5. Сохранение в выписки
await page.locator('#sheetChips .chip', { hasText: 'В выписки' }).click()
await page.waitForTimeout(300)
const stored = await page.evaluate(() => {
  const k = Object.keys(localStorage).find(x => x.startsWith('hl:'))
  return k ? JSON.parse(localStorage.getItem(k)) : []
})
check('выписки: сохранена вместе с разговором', stored.length === 1 && stored[0].thread.length === 2,
  stored[0] ? `реплик: ${stored[0].thread.length}` : 'нет')
const svg = await page.evaluate(() => document.querySelectorAll('#viewer svg g[class^="hl-"]').length)
check('выписки: подсветка нарисована', svg > 0)
await page.evaluate(() => closeSheet())
await page.locator('#btnHl').click()
await page.waitForSelector('#drawer.on')
check('выписки: список в ящике', await page.locator('#drawerBody .item').count() >= 1)
check('выписки: кнопка «всё в вики»', await page.locator('#drawerAct').isVisible())
await page.screenshot({ path: shot('highlights') })
await page.locator('#drawerClose').click()

// 6. «В вики» — отдельный запрос агенту
await page.evaluate(() => openHighlight(state.hl[0]))
await page.waitForSelector('#sheet.on')
await page.locator('#sheetChips .chip', { hasText: 'В вики' }).click()
await page.waitForTimeout(600)
const wikiMsg = await page.evaluate(() => window.__sent[window.__sent.length - 1])
check('вики: агенту ушла просьба сохранить', /Сохрани выписку из книги/.test(wikiMsg.text) && /Наш разговор/.test(wikiMsg.text))
await page.evaluate(() => closeSheet())

// 7. Перезагрузка: полка, позиция и выписки на месте
await page.reload()
await page.waitForSelector('#shelf.on', { timeout: 20000 })
await expose(page)
check('перезагрузка: пароль больше не спрашивают', !(await page.locator('#auth').evaluate(n => n.classList.contains('on'))))
const hero = await page.locator('.hero').count()
check('перезагрузка: карточка «Продолжить»', hero === 1)
await page.locator('.card').first().click()
await page.waitForFunction(() => !!document.querySelector('#viewer iframe'), null, { timeout: 30000 })
await page.waitForTimeout(3000)
const back = await page.evaluate(() => ({
  hl: document.querySelectorAll('#viewer svg g[class^="hl-"]').length,
  pct: document.querySelector('#pct').textContent,
  chap: document.querySelector('#chapLabel').textContent,
}))
check('перезагрузка: выписка вернулась', back.hl > 0, `групп: ${back.hl}`)
check('перезагрузка: позиция и проценты', /\d/.test(back.pct), `${back.pct} · ${back.chap}`)

// 7a. Офлайн: файл книги лежит в своём кэше, сервер для чтения уже не нужен
await page.evaluate(() => closeBook())
await page.waitForSelector('#shelf.on')
await page.route('**/books/*/file', r => r.abort())
await page.locator('.card').first().click()
await page.waitForSelector('#reader.on')
const offline = await page.waitForFunction(() => !!document.querySelector('#viewer iframe'), null, { timeout: 20000 })
  .then(() => true).catch(() => false)
check('офлайн: книга открывается без сервера', offline)
await page.unroute('**/books/*/file')

// 7c. Сервер недоступен: правка не теряется, а ждёт следующей попытки
const hlBefore = Object.keys(srv.hl[BOOK_ID] || {}).length
await page.route('**/books/*/highlights*', r => r.abort())
await selectByDrag(page)
await page.evaluate(() => paint('no'))
await page.waitForTimeout(2600)                       // отложенная отправка успевает сработать и упасть
const stuck = await page.evaluate(() => JSON.parse(localStorage.getItem('dirty') || '[]'))
check('офлайн: правка помечена неотправленной', stuck.includes(BOOK_ID), `помечено: ${JSON.stringify(stuck)}`)
check('офлайн: на сервере её пока нет', Object.keys(srv.hl[BOOK_ID] || {}).length === hlBefore)
await page.unroute('**/books/*/highlights*')
await page.evaluate(() => sync.run())
await page.waitForTimeout(400)
check('офлайн: следующая попытка её доносит',
  Object.keys(srv.hl[BOOK_ID] || {}).length === hlBefore + 1
    && (await page.evaluate(() => JSON.parse(localStorage.getItem('dirty') || '[]'))).length === 0,
  `выписок на сервере: ${Object.keys(srv.hl[BOOK_ID] || {}).length}`)

// 7d. Живая синхронизация: правка с другого устройства приезжает сама, без нашего действия
const anyCfi = Object.values(srv.hl[BOOK_ID])[0].cfi
srv.hl[BOOK_ID]['remote-hl'] = { id: 'remote-hl', cfi: anyCfi, text: 'выписка с другого устройства',
  color: 'imp', chapter: '', note: 'и заметка к ней', thread: [],
  created: Date.now(), updated: Date.now() }
liveTick = { v: 1, book: BOOK_ID, src: 'другое-устройство' }
const arrived = await page.waitForFunction(() => live().some(h => h.id === 'remote-hl'), null, { timeout: 20000 })
  .then(() => true).catch(() => false)
check('живая синхронизация: чужая выписка приехала сама', arrived)
check('живая синхронизация: с заметкой',
  arrived && await page.evaluate(() => live().find(h => h.id === 'remote-hl').note) === 'и заметка к ней')

// И удаление доезжает так же: на том устройстве выписку стёрли — здесь она гаснет сама
srv.hl[BOOK_ID]['remote-hl'].deleted = true
srv.hl[BOOK_ID]['remote-hl'].updated = Date.now()
liveTick = { v: 2, book: BOOK_ID, src: 'другое-устройство' }
check('живая синхронизация: чужое удаление тоже',
  await page.waitForFunction(() => !live().some(h => h.id === 'remote-hl'), null, { timeout: 20000 })
    .then(() => true).catch(() => false))

// А своё же эхо забирать не нужно: сервер вернул наше имя — состояние не перечитываем
const me = await page.evaluate(() => JSON.parse(localStorage.getItem('client')))
liveTick = { v: 3, book: BOOK_ID, src: me }
const statesBefore = states
await page.waitForTimeout(5000)                       // хватает на пару переподключений
check('живая синхронизация: своё же эхо не забираем', states === statesBefore,
  `запросов состояния: ${states - statesBefore}`)
liveTick = null

// 7e. Поиск по книге: находка не просто показывается, а открывается
await page.locator('#btnFind').click()
await page.waitForSelector('#drawer.on')
await page.locator('.findbox input').fill('возражение')
const found = await page.waitForFunction(() => document.querySelectorAll('#drawerBody .item').length > 0,
  null, { timeout: 25000 }).then(() => true).catch(() => false)
check('поиск: по книге что-то нашлось', found, `находок: ${await page.locator('#drawerBody .item').count()}`)
check('поиск: искомое подсвечено в находке', await page.locator('#drawerBody .item mark').count() > 0)
await page.locator('#drawerBody .item').first().click()
await page.waitForTimeout(1000)
const jumped = await page.evaluate(() => ({
  text: (document.querySelector('#viewer iframe').contentDocument.body.innerText || '').includes('возражение'),
  drawer: document.querySelector('#drawer').classList.contains('on'),
}))
check('поиск: находка открывается в книге', jumped.text && !jumped.drawer,
  `на странице: ${jumped.text}, ящик закрыт: ${!jumped.drawer}`)

// 7f. Ползунок прогресса
const scrub = await page.evaluate(async () => {
  const s = document.querySelector('#scrub')
  if (s.disabled) return { on: false }
  const at = () => { const c = state.rendition.currentLocation(); return c && c.start ? c.start.cfi : '' }
  const before = at()
  s.value = 700
  s.dispatchEvent(new Event('input', { bubbles: true }))
  const label = document.querySelector('#chapLabel').textContent
  const pct = document.querySelector('#pct').textContent
  s.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 1200))
  return { on: true, moved: before !== at(), label, pct }
})
check('ползунок: включается, когда посчитаны локации', scrub.on)
check('ползунок: пока тянут — видно главу и процент', !!scrub.label && /\d+%/.test(scrub.pct || ''),
  `${scrub.label} · ${scrub.pct}`)
check('ползунок: отпустили — книга перешла', scrub.moved)

// 7g. Своя заметка к выписке
const noted = await page.evaluate(async () => {
  const h = live()[0]
  openHighlight(h)
  await new Promise(r => setTimeout(r, 300))
  const box = document.querySelector('#sheetNote')
  const shown = getComputedStyle(box).display !== 'none'
  box.value = 'вернуться к этому месту'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 1000))          // отложенное сохранение
  closeSheet()
  const saved = JSON.parse(localStorage.getItem('hl:' + state.entry.id)).find(x => x.id === h.id)
  return { shown, id: h.id, note: saved.note }
})
check('заметка: поле показано у сохранённой выписки', noted.shown)
check('заметка: сохранилась к выписке', noted.note === 'вернуться к этому месту', noted.note)
await page.evaluate(() => sync.run({ force: true }))
await page.waitForTimeout(500)
check('заметка: уехала на сервер', (srv.hl[BOOK_ID][noted.id] || {}).note === 'вернуться к этому месту')

// 7b. Синхронизация: уходим со страницы — прогресс должен уехать на сервер
await page.evaluate(async () => {
  await state.rendition.next(); await state.rendition.next();
  await new Promise(r => setTimeout(r, 400));
})
await page.evaluate(() => closeBook())
await page.waitForTimeout(1200)
const phoneHl = await page.evaluate(() => live().length)
const phonePos = await page.evaluate(() => {
  const id = lib()[0].id
  return { id, pos: localStorage.getItem('pos:' + id), pct: JSON.parse(localStorage.getItem('pct:' + id) || '0') }
})
check('синхронизация: состояние ушло на сервер', !!srv.pos[phonePos.id],
  `отправок выписок: ${pushes}`)
check('синхронизация: позиция и выписка на сервере',
  srv.pos[phonePos.id].cfi === JSON.parse(phonePos.pos)
    && Object.values(srv.hl[phonePos.id] || {}).filter(h => !h.deleted).length === phoneHl,
  `выписок: ${Object.values(srv.hl[phonePos.id] || {}).length}, на телефоне ${phoneHl}`)

// 7h. Учёт чтения: закрыли книгу — отметка о прочитанном ушла на сервер
check('чтение: отметка ушла на сервер', beats.length > 0,
  `отметок: ${beats.length}, последняя: ${JSON.stringify(beats[beats.length - 1] || {})}`)
check('чтение: в отметке день читателя и продвижение',
  beats.some(b => /^\d{4}-\d{2}-\d{2}$/.test(b.day) && b.pct > 0),
  JSON.stringify(beats[beats.length - 1] || {}))

// 7i. Экран статистики: плитки, карточки, разбивка по книгам
await page.evaluate(() => openStats())
await page.waitForSelector('#stats.on')
await page.waitForFunction(() => document.querySelectorAll('#statsBody .cell[data-day]').length > 0,
  null, { timeout: 10000 })
const stats = await page.evaluate(() => ({
  cards: [...document.querySelectorAll('.stat-card .big')].map(n => n.textContent.trim()),
  cells: document.querySelectorAll('#statsBody .cell[data-day]').length,
  lit: document.querySelectorAll('#statsBody .cell[data-day]:not(.l0)').length,
  marked: document.querySelectorAll('#statsBody .cell.marked').length,
  books: document.querySelectorAll('.stat-book').length,
  shelfHidden: !document.querySelector('#shelf').classList.contains('on'),
  months: [...document.querySelectorAll('.cal-month')].filter(n => n.textContent).length,
  // Полоса по книге должна стоять в строке, а не улететь абсолютом на край экрана.
  laneInRow: (() => {
    const lane = document.querySelector('.stat-book .lane')
    if (!lane) return false
    const row = lane.closest('.stat-book').getBoundingClientRect(), b = lane.getBoundingClientRect()
    return b.top >= row.top && b.bottom <= row.bottom && b.width > 20
  })(),
}))
check('статистика: карточки посчитаны', stats.cards[0] === '2' && /ч|мин/.test(stats.cards[1] || ''),
  stats.cards.join(' · '))
check('статистика: полгода плиток', stats.cells >= 182 && stats.cells <= 189, `клеток: ${stats.cells}`)
check('статистика: дни с чтением подсвечены', stats.lit === 3, `подсвечено: ${stats.lit}`)
check('статистика: день с выписками помечен точкой', stats.marked === 1)
check('статистика: подписи месяцев расставлены', stats.months >= 5, `подписей: ${stats.months}`)
check('статистика: разбивка по книгам', stats.books === 1)
check('статистика: полоса книги стоит в своей строке', stats.laneInRow)
check('статистика: полка не просвечивает', stats.shelfHidden)
const tapDay = await page.evaluate(() => {
  const cell = [...document.querySelectorAll('#statsBody .cell[data-day]')].filter(c => !c.classList.contains('l0')).pop()
  cell.click()
  return { day: cell.dataset.day, on: cell.classList.contains('on'),
           pick: document.querySelector('#calPick').textContent }
})
check('статистика: тап по плитке рассказывает про день',
  tapDay.on && /мин|ч/.test(tapDay.pick) && tapDay.pick.length > 6, tapDay.pick)
await page.screenshot({ path: shot('stats') })
await page.evaluate(() => closeStats())
await page.waitForFunction(() => document.querySelector('#shelf').classList.contains('on'))

// 8. Большой экран — второе «устройство»: подхватывает позицию и выписки телефона
const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await dctx.route('**/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"token":"T","ok":true}' }))
await dctx.route('**/books', booksRoute)
await dctx.route('**/books/**', booksRoute)
await dctx.addInitScript(STUB)
const dpage = await dctx.newPage()
dpage.on('pageerror', e => console.log('  [pageerror desktop]', e.message))
await dpage.goto(URL_)
await dpage.waitForSelector('#auth.on')
await expose(dpage)
await dpage.fill('#authPass', 'secret'); await dpage.click('#authGo')
await dpage.waitForSelector('#shelf.on')
// Библиотека на сервере — книга на полке уже есть, добавлять нечего.
check('полка: второе устройство видит книгу с сервера', await dpage.locator('.card .t').first().textContent() === FIXTURE.title)
await dpage.locator('.card').first().click()
await dpage.waitForSelector('#reader.on')
await dpage.waitForFunction(() => !!document.querySelector('#viewer iframe'), null, { timeout: 30000 })
await dpage.waitForTimeout(1500)
const dsynced = await dpage.evaluate(() => {
  const id = lib()[0].id
  // Считаем живые: надгробия удалённых хранятся тут же, но выписками уже не считаются.
  return { pos: localStorage.getItem('pos:' + id),
           hl: JSON.parse(localStorage.getItem('hl:' + id) || '[]').filter(h => !h.del).length }
})
check('синхронизация: второе устройство забрало позицию', dsynced.pos && JSON.parse(dsynced.pos) === JSON.parse(phonePos.pos),
  `${(JSON.parse(dsynced.pos || '""') || '').slice(-22)}`)
check('синхронизация: и выписки тоже', dsynced.hl === phoneHl, `выписок: ${dsynced.hl}, на телефоне ${phoneHl}`)

const dopened = await dpage.evaluate(() => {
  const cur = state.rendition.currentLocation()
  return { cfi: cur && cur.start ? cur.start.cfi : '', hl: document.querySelectorAll('#viewer svg g[class^="hl-"]').length,
           n: state.hl.length, first: (state.hl[0] || {}).cfi }
})
check('синхронизация: книга открылась там же, где на телефоне', dopened.cfi === JSON.parse(phonePos.pos),
  `${dopened.cfi}`)
// Выписка приехала с телефона: её cfi должен не только храниться, но и нарисоваться.
const ddrew = await dpage.evaluate(async () => {
  const h = state.hl[0]
  if (!h) return -1
  await state.rendition.display(h.cfi)
  await new Promise(r => setTimeout(r, 600))
  return document.querySelectorAll(`#viewer svg g[data-id="${h.id}"]`).length
})
check('синхронизация: выписка с телефона рисуется', ddrew > 0, `групп: ${ddrew}`)
// Первая секция — обложка: на ней нечего мерить, доезжаем до прозы.
await dpage.evaluate(async () => {
  for (const item of state.book.spine.spineItems.slice(0, 24)) {
    await state.rendition.display(item.href)
    await new Promise(r => setTimeout(r, 140))
    const doc = document.querySelector('#viewer iframe').contentDocument
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = w.nextNode())) if (node.textContent.trim().length > 200) return item.href
  }
})
await dpage.waitForTimeout(2500)
const layout = await dpage.evaluate(() => {
  const r = state.rendition, lay = r._layout || (r.manager && r.manager.layout) || {}
  const v = document.querySelector('#viewer')
  return { divisor: lay.divisor, spread: v.classList.contains('spread'), w: v.clientWidth }
})
check('десктоп: разворот в две страницы', layout.divisor === 2 && layout.spread, `divisor=${layout.divisor}, полоса ${layout.w}px`)
const fit = await dpage.evaluate(() => {
  const f = document.querySelector('#viewer iframe'), fr = f.getBoundingClientRect()
  const doc = f.contentDocument
  const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  let node, minTop = 1e9, maxBot = -1e9
  while ((node = w.nextNode())) {
    if (!node.textContent.trim()) continue
    const r = doc.createRange(); r.selectNodeContents(node)
    for (const b of r.getClientRects()) {
      if (b.width < 2 || b.height < 2) continue
      minTop = Math.min(minTop, fr.top + b.top); maxBot = Math.max(maxBot, fr.top + b.bottom)
    }
  }
  return { minTop, maxBot, chrome: document.querySelector('#topbar').getBoundingClientRect().bottom,
           floor: document.querySelector('#viewer').getBoundingClientRect().bottom }
})
check('десктоп: строки нашлись', fit.maxBot > 0)
check('десктоп: строка не под шапкой и не обрезана', fit.minTop >= fit.chrome - 1 && fit.maxBot <= fit.floor + 1,
  `${Math.round(fit.minTop)}…${Math.round(fit.maxBot)} при ${Math.round(fit.chrome)}…${Math.round(fit.floor)}`)
// 8b. Клик по готовой выписке: открыть её, ничего больше не задев
const dmarked = await selectByDrag(dpage)
await dpage.evaluate(() => paint('imp'))
await dpage.waitForTimeout(300)
const dmark = await markCenter(dpage)
check('десктоп: выписка нарисована там, куда можно попасть', !!dmark, JSON.stringify((dmarked || '').slice(0, 30)))
await dpage.mouse.click(dmark.x, dmark.y)
await dpage.waitForTimeout(400)
const dtap = await dpage.evaluate(() => ({
  sheet: document.querySelector('#sheet').classList.contains('on'),
  imm: document.querySelector('#reader').classList.contains('immersive'),
  active: state.active && state.active.id,
}))
check('десктоп: клик по выписке открывает её', dtap.sheet && dtap.active === dmark.id)
check('десктоп: и не гасит полосы заодно', !dtap.imm)
await dpage.mouse.click(dmark.x, Math.max(90, dmark.y - 60))
await dpage.waitForTimeout(400)
check('десктоп: клик по затемнению закрывает шторку',
  await dpage.evaluate(() => !document.querySelector('#sheet').classList.contains('on')))

await selectByDrag(dpage)
await dpage.keyboard.press('Escape')
await dpage.waitForTimeout(200)
check('десктоп: Escape снимает выделение',
  await dpage.evaluate(() => !document.querySelector('#selbar').classList.contains('on')
    && document.querySelectorAll('#selLayer .selrect').length === 0))
await dpage.screenshot({ path: shot('desktop') })

// 9. Тема и PWA
await dpage.evaluate(() => { state.theme = 'dark'; applyTheme() })
await dpage.waitForTimeout(400)
// epub.js вставляет тему через insertRule — в разметке её нет, смотрим на посчитанный стиль.
const dark = await dpage.evaluate(() => {
  const doc = document.querySelector('#viewer iframe').contentDocument
  const cs = doc.defaultView.getComputedStyle(doc.body)
  return { theme: document.documentElement.dataset.theme, bg: cs.backgroundColor, ink: cs.color }
})
check('тема: тёмная применяется к книге',
  dark.theme === 'dark' && dark.bg.replace(/\s/g, '') === 'rgb(22,21,26)', `${dark.bg} / ${dark.ink}`)
await dpage.screenshot({ path: shot('dark') })
const man = await page.evaluate(async () => (await fetch('manifest.webmanifest')).status)
check('PWA: манифест отдаётся', man === 200)

// 10. Тап пальцем по выписке — отдельный контекст с настоящим тачем.
// На тач-экране epub.js отдаёт попадание по метке ещё на touchstart: шторка встаёт
// под палец, и click, прилетающий после отпускания, попадает уже в затемнение.
const tctx = await browser.newContext({ ...devices['iPhone 13'], hasTouch: true })
await tctx.route('**/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"token":"T","ok":true}' }))
await tctx.route('**/books', booksRoute)
await tctx.route('**/books/**', booksRoute)
await tctx.addInitScript(STUB)
const tpage = await tctx.newPage()
tpage.on('pageerror', e => console.log('  [pageerror touch]', e.message))
await tpage.goto(URL_)
await tpage.waitForSelector('#auth.on')
await expose(tpage)
await tpage.fill('#authPass', 'secret'); await tpage.click('#authGo')
await tpage.waitForSelector('#shelf.on', { timeout: 15000 })
await tpage.locator('.card').first().click()
await tpage.waitForSelector('#reader.on')
await tpage.waitForFunction(() => !!document.querySelector('#viewer iframe'), null, { timeout: 30000 })
await toProse(tpage)
await tpage.waitForTimeout(600)
const tmarked = await paintAt(tpage)
await tpage.waitForTimeout(300)
const tmark = await markCenter(tpage)
const tliveBefore = await tpage.evaluate(() => live().length)
check('тач: выписка нарисована', !!tmark, JSON.stringify((tmarked || '').slice(0, 30)))
await tpage.touchscreen.tap(tmark.x, tmark.y)
await tpage.waitForTimeout(900)
const ttap = await tpage.evaluate(() => ({
  sheet: document.querySelector('#sheet').classList.contains('on'),
  scrim: document.querySelector('#scrim').classList.contains('on'),
  imm: document.querySelector('#reader').classList.contains('immersive'),
  active: state.active && state.active.id,
  del: document.querySelectorAll('#sheetChips .chip').length,
}))
check('тач: тап по выписке открывает её', ttap.sheet && ttap.active === tmark.id)
check('тач: шторка не закрывается сама следом', ttap.sheet && ttap.scrim)
check('тач: полосы читалки не мигнули', !ttap.imm)
check('тач: в шторке есть чем управлять выпиской', ttap.del >= 2, `кнопок: ${ttap.del}`)
// Долгий разговор должен прокручиваться внутри шторки, а не заезжать под кнопки.
const fits = await tpage.evaluate(() => {
  const b = document.querySelector('#sheetBody').getBoundingClientRect()
  const c = document.querySelector('#sheetChips').getBoundingClientRect()
  const s = document.querySelector('#sheet').getBoundingClientRect()
  return { over: Math.round(b.bottom - c.top), tall: Math.round(s.bottom - window.innerHeight) }
})
check('тач: разговор не заезжает под кнопки шторки', fits.over <= 1 && fits.tall <= 1,
  `нахлёст ${fits.over}px, за экран ${fits.tall}px`)
await tpage.screenshot({ path: shot('mark-tap') })
// Тыкать надо именно в затемнение — выше шторки, но ниже верхней полосы.
const scrimPt = await tpage.evaluate(() => {
  const x = Math.round(window.innerWidth / 2)
  const y = Math.round(Math.max(70, document.querySelector('#sheet').getBoundingClientRect().top - 40))
  const n = document.elementFromPoint(x, y)
  return { x, y, hit: n ? (n.id || n.nodeName) : 'null' }
})
await tpage.touchscreen.tap(scrimPt.x, scrimPt.y)
await tpage.waitForTimeout(500)
check('тач: своим тапом затемнение шторку закрывает',
  await tpage.evaluate(() => !document.querySelector('#sheet').classList.contains('on')), `тапнули в ${scrimPt.hit}`)
// И удаление после повторного входа в выписку — то, ради чего в неё и тыкают.
await tpage.touchscreen.tap(tmark.x, tmark.y)
await tpage.waitForSelector('#sheet.on', { timeout: 5000 })
await tpage.waitForTimeout(400)
await tpage.locator('#sheetChips .chip', { hasText: 'Удалить' }).click()
await tpage.waitForTimeout(400)
const tgone = await tpage.evaluate(id => ({
  mark: !!document.querySelector(`#viewer svg g[data-id="${id}"]`),
  live: live().length, sheet: document.querySelector('#sheet').classList.contains('on'),
  hl: state.hl.map(h => h.id + (h.del ? ':del' : '')).join(','),
}), tmark.id)
check('тач: выписку можно удалить', !tgone.sheet && !tgone.mark && tgone.live === tliveBefore - 1,
  `живых было ${tliveBefore}, стало ${tgone.live} (${tgone.hl})`)

console.log('\nOK:')
ok.forEach(x => console.log('  +', x))
if (bad.length) { console.log('\nПРОБЛЕМЫ:'); bad.forEach(x => console.log('  -', x)) }
await browser.close()
await server.close()
process.exit(bad.length ? 1 : 0)
