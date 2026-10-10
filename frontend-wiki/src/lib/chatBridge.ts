import { storageParsePrompt } from './api'
import { filesLabel } from './i18n'

/* Мост «Файлы → Чат». StorageView и поле ввода не знают про ChatPane: они шлют событие,
   а ChatPane его слушает и отправляет через свой сокет. */

export const CHAT_SEND_EVENT = 'bender:chat-send'

/** text уходит агенту, shown остаётся в ленте: служебную просьбу с путями внутри
    контейнера человеку читать незачем — ему хватит имён файлов. */
export interface ChatSend { text: string; shown: string }

export function sendToChat(msg: ChatSend) {
  window.dispatchEvent(new CustomEvent<ChatSend>(CHAT_SEND_EVENT, { detail: msg }))
}

/** Просьба разобрать файлы хранилища. Одна на все файлы: чат ведёт один ход за раз. */
export async function parseRequest(files: { path: string; name: string }[]): Promise<ChatSend> {
  const text = await storageParsePrompt(files.map(f => f.path))
  return { text, shown: filesLabel(files.map(f => f.name)) }
}
