/* Книга для проверок собирается на месте: настоящий epub в репозиторий не положить (права),
   а набору проверок нужен файл с обложкой, оглавлением и достаточным текстом на несколько страниц. */
import JSZip from 'jszip'

const TITLE = 'Проверка чтения'
const AUTHOR = 'Тестовый Автор'

const PARAS = [
  'Читать внимательно — значит уметь остановиться. Не там, где текст кончился, а там, где мысль ещё не улеглась: '
    + 'страница держит внимание ровно столько, сколько нужно, чтобы фраза успела задеть что-то своё, а не проехала мимо '
    + 'вместе с остальными строками. Именно поэтому подчёркивание — не украшение, а способ отметить место, где ты '
    + 'остановился и почему.',
  'Хорошая книга сопротивляется скорости. Она устроена так, что быстрое чтение вымывает из неё всё, кроме сюжета, '
    + 'а сюжет здесь не главное; главное — порядок, в котором автор кладёт доводы, и то, что он оставляет читателю '
    + 'достроить самому. Пропустив этот зазор, получаешь пересказ вместо понимания и удивляешься, почему через месяц '
    + 'ничего не помнишь.',
  'Выписки живут дольше книги. Через год от прочитанного остаётся не текст, а несколько фраз и своя мысль рядом с ними, '
    + 'и если этой мысли не записать сразу, она не вернётся: контекст выветривается быстрее, чем кажется в момент чтения. '
    + 'Поэтому цвет выписки полезно выбирать по смыслу, а не по вкусу — иначе через сто отметок в них не разобраться.',
  'Спорить с автором продуктивнее, чем соглашаться. Согласие ничего не добавляет к тому, что уже есть в голове, '
    + 'а несогласие заставляет назвать своё возражение словами — и часто по дороге выясняется, что возражение слабее '
    + 'довода, зато теперь понятно, почему. Это и есть чтение: не приём информации, а разговор, в котором вторая сторона '
    + 'не может себя защитить.',
  'Порядок важнее полноты. Прочитать половину книги и удержать её строение полезнее, чем пролистать целиком и запомнить '
    + 'обрывки: строение подскажет, куда вернуться, а обрывки не подскажут ничего. Отсюда простое правило — сначала '
    + 'оглавление, потом главы, и только потом попытка объяснить прочитанное своими словами кому-нибудь, кто книги не '
    + 'читал.',
]

const CHAPTERS = [
  'Вступление', 'О внимании', 'О выписках', 'О несогласии', 'О порядке',
]

const page = (title, seed) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ru" lang="ru">
<head><title>${title}</title></head>
<body>
<h1>${title}</h1>
${Array.from({ length: 7 }, (_, i) => `<p>${PARAS[(seed + i) % PARAS.length]}</p>`).join('\n')}
</body>
</html>
`

// Однопиксельный PNG: полке нужна картинка, из которой она сделает миниатюру.
const COVER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64')

/** @returns {Promise<Buffer>} готовый файл epub */
export async function makeEpub() {
  const zip = new JSZip()
  // mimetype обязан лежать первым и без сжатия — иначе файл не epub.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`)
  const items = CHAPTERS.map((c, i) => ({ id: `ch${i + 1}`, href: `ch${i + 1}.xhtml`, label: c }))
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bid">urn:uuid:2f8e1c40-books-test</dc:identifier>
    <dc:title>${TITLE}</dc:title>
    <dc:creator>${AUTHOR}</dc:creator>
    <dc:language>ru</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>
${items.map(i => `    <item id="${i.id}" href="${i.href}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine>
${items.map(i => `    <itemref idref="${i.id}"/>`).join('\n')}
  </spine>
</package>
`)
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ru">
<head><title>Оглавление</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Оглавление</h1><ol>
${items.map(i => `<li><a href="${i.href}">${i.label}</a></li>`).join('\n')}
</ol></nav>
</body>
</html>
`)
  zip.file('OEBPS/cover.png', COVER)
  items.forEach((i, n) => zip.file('OEBPS/' + i.href, page(i.label, n)))
  return zip.generateAsync({ type: 'nodebuffer' })
}

export const FIXTURE = { title: TITLE, author: AUTHOR, chapters: CHAPTERS }
