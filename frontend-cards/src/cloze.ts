/* Фраза с пропусками в записи Anki: «Столица {{c1::Франции}} — {{c2::Париж::город}}».
   На каждый номер своя карточка; у пропуска может быть подсказка после второго «::». */

const CLOZE = /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/gs;

export type Piece = { text: string } | { n: number; answer: string; hint: string };

export function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const m of text.matchAll(CLOZE)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ n: Number(m[1]), answer: m[2], hint: m[3] ?? "" });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** Номера пропусков по возрастанию — столько карточек получится из фразы. */
export const numbers = (text: string): number[] =>
  [...new Set([...text.matchAll(CLOZE)].map((m) => Number(m[1])))].sort((a, b) => a - b);

/** Обернуть выделенный кусок в следующий по счёту пропуск. */
export function wrap(text: string, from: number, to: number): string {
  if (to <= from) return text;
  const next = Math.max(0, ...numbers(text)) + 1;
  return text.slice(0, from) + `{{c${next}::` + text.slice(from, to) + "}}" + text.slice(to);
}

/** Фраза без разметки — для списков и поиска глазами. */
export const plain = (text: string): string => text.replace(CLOZE, "$2");
