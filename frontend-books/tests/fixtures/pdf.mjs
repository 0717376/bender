/* Минимальный валидный pdf: строка текста на странице, три закладки-раздела.
   Тот же макет, что у make_pdf в тестах бэкенда — проверяем один и тот же файл
   с двух сторон. Собирается руками, чтобы не тянуть библиотеку записи. */

export const PDF_FIXTURE = {
  title: 'Проверка PDF',
  author: 'Автор Пдф',
  pages: 6,
  outline: [
    { title: 'Начало', page: 1 },
    { title: 'Середина', page: 3 },
    { title: 'Конец', page: 5 },
  ],
}

/* Строка pdf: ASCII — литералом, остальное — UTF-16BE с BOM в hex-строке. */
const pdfstr = s => {
  if (/^[\x20-\x7e]*$/.test(s)) return '(' + s.replace(/[\\()]/g, m => '\\' + m) + ')'
  const bytes = []
  for (const ch of '\ufeff' + s) {
    const code = ch.codePointAt(0)
    bytes.push((code >> 8) & 0xff, code & 0xff)
  }
  return '<' + bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase() + '>'
}

export function makePdf({ pages = PDF_FIXTURE.pages, outline = true } = {}) {
  const n = pages
  const objs = {}
  objs[2] = '<< /Type /Pages /Kids ['
    + Array.from({ length: n }, (_, i) => `${5 + i} 0 R`).join(' ') + `] /Count ${n} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objs[4] = `<< /Title ${pdfstr(PDF_FIXTURE.title)} /Author ${pdfstr(PDF_FIXTURE.author)} >>`
  for (let i = 1; i <= n; i++) {
    objs[4 + i] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 540 648] '
      + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${4 + n + i} 0 R >>`
    const stream = `BT /F1 12 Tf 72 600 Td (Stranica ${i}. Slova dlya poiska agenta.) Tj ET`
    objs[4 + n + i] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  }
  let root = ''
  if (outline) {
    const o = 5 + 2 * n
    const marks = PDF_FIXTURE.outline
    objs[o] = `<< /Type /Outlines /First ${o + 1} 0 R /Last ${o + marks.length} 0 R /Count ${marks.length} >>`
    marks.forEach((m, k) => {
      const around = (k > 0 ? ` /Prev ${o + k} 0 R` : '')
        + (k < marks.length - 1 ? ` /Next ${o + k + 2} 0 R` : '')
      objs[o + k + 1] = `<< /Title ${pdfstr(m.title)} /Parent ${o} 0 R${around} `
        + `/Dest [${4 + m.page} 0 R /XYZ null null null] >>`
    })
    root = ` /Outlines ${o} 0 R`
  }
  objs[1] = `<< /Type /Catalog /Pages 2 0 R${root} >>`

  const parts = ['%PDF-1.4\n']
  const offsets = {}
  let at = parts[0].length
  const nums = Object.keys(objs).map(Number).sort((a, b) => a - b)
  for (const num of nums) {
    offsets[num] = at
    const chunk = `${num} 0 obj\n${objs[num]}\nendobj\n`
    parts.push(chunk)
    at += chunk.length
  }
  const total = Math.max(...nums) + 1
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`
  for (let num = 1; num < total; num++) xref += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`
  parts.push(xref)
  parts.push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${at}\n%%EOF\n`)
  return Buffer.from(parts.join(''), 'latin1')
}
