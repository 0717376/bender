import { mkdirSync } from 'node:fs'
import { webkit, devices } from 'playwright'
import { build, preview } from 'vite'
import { makeEpub, FIXTURE } from './fixtures/epub.mjs'

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

/* Подставная вики: состояние синхронизации живёт в памяти теста и общее для обоих
   «устройств» — так проверяется, что прогресс действительно переезжает. */
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
let syncDoc = null, puts = 0
const syncRoute = async r => {
  const req = r.request()
  if (req.method() === 'PUT') {
    puts++
    syncDoc = JSON.parse(JSON.parse(req.postData()).text)
    return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{"ok":true}' })
  }
  if (!syncDoc) return r.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{"detail":"нет"}' })
  return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json',
    body: JSON.stringify({ path: '.reader/state.json', text: JSON.stringify(syncDoc) }) })
}

const browser = await webkit.launch()
const ctx = await browser.newContext({ ...devices['iPhone 13'], hasTouch: false })
await ctx.route('**/auth/login', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"token":"T"}' }))
await ctx.route('**/auth/me', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
await ctx.route('**/files/content**', syncRoute)
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
    if (b.width > 8 && b.top > 70 && b.bottom < window.innerHeight - 140)
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
check('агент: сокет с токеном и surface', /token=T&surface=wiki/.test(await page.evaluate(() => window.__wsUrl)))
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

// 7b. Синхронизация: уходим со страницы — прогресс должен уехать на сервер
await page.evaluate(async () => {
  await state.rendition.next(); await state.rendition.next();
  await new Promise(r => setTimeout(r, 400));
})
await page.evaluate(() => closeBook())
await page.waitForTimeout(1200)
const phonePos = await page.evaluate(() => {
  const id = lib()[0].id
  return { id, pos: localStorage.getItem('pos:' + id), pct: JSON.parse(localStorage.getItem('pct:' + id) || '0') }
})
check('синхронизация: состояние ушло на сервер', !!syncDoc && !!syncDoc.books[phonePos.id],
  `книг в документе: ${syncDoc ? Object.keys(syncDoc.books).length : 0}, записей: ${puts}`)
check('синхронизация: позиция и выписка в документе',
  syncDoc.books[phonePos.id].pos === JSON.parse(phonePos.pos) && syncDoc.books[phonePos.id].hl.length === 1,
  `выписок: ${syncDoc ? syncDoc.books[phonePos.id].hl.length : 0}`)

// 8. Большой экран — второе «устройство»: подхватывает позицию и выписки телефона
const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await dctx.route('**/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"token":"T","ok":true}' }))
await dctx.route('**/files/content**', syncRoute)
await dctx.addInitScript(STUB)
const dpage = await dctx.newPage()
dpage.on('pageerror', e => console.log('  [pageerror desktop]', e.message))
await dpage.goto(URL_)
await dpage.waitForSelector('#auth.on')
await expose(dpage)
await dpage.fill('#authPass', 'secret'); await dpage.click('#authGo')
await dpage.waitForSelector('#shelf.on')
// Тот же файл даёт тот же id (хеш содержимого) — на этом и сходятся два устройства.
await addBook(dpage)
await dpage.waitForTimeout(1500)
const dsynced = await dpage.evaluate(() => {
  const id = lib()[0].id
  return { pos: localStorage.getItem('pos:' + id), hl: JSON.parse(localStorage.getItem('hl:' + id) || '[]').length }
})
check('синхронизация: второе устройство забрало позицию', dsynced.pos && JSON.parse(dsynced.pos) === JSON.parse(phonePos.pos),
  `${(JSON.parse(dsynced.pos || '""') || '').slice(-22)}`)
check('синхронизация: и выписки тоже', dsynced.hl === 1, `выписок: ${dsynced.hl}`)

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
await tctx.route('**/files/content**', syncRoute)
await tctx.addInitScript(STUB)
const tpage = await tctx.newPage()
tpage.on('pageerror', e => console.log('  [pageerror touch]', e.message))
await tpage.goto(URL_)
await tpage.waitForSelector('#auth.on')
await expose(tpage)
await tpage.fill('#authPass', 'secret'); await tpage.click('#authGo')
await tpage.waitForSelector('#shelf.on', { timeout: 15000 })
await addBook(tpage)
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
