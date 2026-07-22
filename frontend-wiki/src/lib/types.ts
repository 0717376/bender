export type WSMessage =
  | { t: 'text'; id: string; text: string }
  | { t: 'tool'; name: string; pattern?: string; file?: string }
  | { t: 'error'; text: string }
  | { t: 'done'; sid?: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'error' | 'tool-use' | 'system'
  html: string
  markdown?: string
}

export interface FileNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: FileNode[]
  size?: number
  mtime?: number
}

export const TOOL_LABELS: Record<string, string> = {
  Read: 'Читаю',
  Glob: 'Ищу файлы',
  Grep: 'Ищу в вики',
  Write: 'Пишу файл',
  Edit: 'Редактирую',
  MultiEdit: 'Редактирую',
  Bash: 'Выполняю команду',
  WebSearch: 'Поиск в сети',
  WebFetch: 'Загружаю страницу',
  TodoWrite: 'Планирую',
}
