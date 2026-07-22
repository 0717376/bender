export type Lang = 'ru' | 'en'

const stored = localStorage.getItem('wiki_lang')
export const lang: Lang =
  stored === 'ru' || stored === 'en'
    ? stored
    : navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en'

export function setLang(l: Lang) {
  localStorage.setItem('wiki_lang', l)
  location.reload()
}

const ru = lang === 'ru'

const RU = {
  loginError: 'Ошибка входа',
  password: 'Пароль',
  signIn: 'Войти',
  tabFiles: 'Обзор',
  tabPage: 'Страница',
  assistant: 'Ассистент',
  chatHint1: 'Спросите ассистента про вики',
  chatHint2: 'или попросите что-то записать.',
  roleAssistant: 'ассистент',
  roleUser: 'вы',
  sendFailed: 'Не удалось отправить сообщение',
  clearTitle: 'Очистить контекст',
  clear: 'Очистить',
  attachPage: 'Прикрепить страницу',
  detachPage: 'Убрать страницу из контекста',
  clearSelection: 'Убрать выделение',
  wiki: 'Вики',
  newPage: 'Новая страница',
  newFolder: 'Новая папка',
  refresh: 'Обновить',
  settings: 'Настройки',
  close: 'Закрыть',
  theme: 'Тема',
  themeLight: 'Светлая',
  themeDark: 'Тёмная',
  themeAuto: 'Авто',
  palette: 'Расцветка',
  language: 'Язык',
  langRu: 'Русский',
  langEn: 'English',
  palIndigo: 'Индиго',
  palForest: 'Лес',
  palOcean: 'Океан',
  palPlum: 'Слива',
  palAmber: 'Янтарь',
  palRosewood: 'Роза',
  palInk: 'Тушь',
  palMatcha: 'Матча',
  palSky: 'Небо',
  newPageHere: 'Новая страница здесь',
  newFolderHere: 'Новая папка здесь',
  rename: 'Переименовать',
  delete: 'Удалить',
  emptyTree: 'Пусто. Создайте страницу.',
  moveToRoot: 'Переместить в корень',
  folderName: 'имя папки',
  pageName: 'имя страницы',
  voiceInput: 'Голосовой ввод',
  askAssistant: 'Спросите ассистента…',
  send: 'Отправить',
  pickPage: 'Выберите страницу из списка файлов',
  saving: 'Сохранение…',
  saved: 'Сохранено',
  edit: 'Редактировать',
  view: 'Просмотр',
  copy: 'Скопировать',
  copied: 'Скопировано',
  storage: 'Файлы',
  upload: 'Загрузить файлы',
  emptyStorage: 'Пусто. Загрузите файл или пришлите его боту.',
  pickFile: 'Выберите файл из списка',
  download: 'Скачать',
  openInTab: 'Открыть в новой вкладке',
  fileMissing: 'Файл не найден — возможно, его переместили или удалили. Список обновлён.',
  actions: 'Действия',
  openAssistant: 'Открыть ассистента',
  collapseChat: 'Свернуть',
  emptyFolder: 'Папка пуста',
  uploadHint: 'Перетащите файлы сюда или загрузите с устройства',
  back: 'Назад',
  open: 'Открыть',
  mcpTitle: 'Доступ для агентов (MCP)',
  mcpHint: 'Внешние агенты — Claude Code и другие MCP-клиенты — могут читать и пополнять вики и задачи.',
  mcpEndpoint: 'Адрес',
  mcpToken: 'Токен',
  mcpCopyCmd: 'Команда для Claude Code',
  mcpRotate: 'Перевыпустить токен',
  mcpRotateConfirm: 'Старый токен перестанет работать у всех подключённых клиентов. Перевыпустить?',
} as const

const EN: Record<keyof typeof RU, string> = {
  loginError: 'Login failed',
  password: 'Password',
  signIn: 'Sign in',
  tabFiles: 'Browse',
  tabPage: 'Page',
  assistant: 'Assistant',
  chatHint1: 'Ask the assistant about your wiki',
  chatHint2: 'or dictate something to write down.',
  roleAssistant: 'assistant',
  roleUser: 'you',
  sendFailed: 'Failed to send the message',
  clearTitle: 'Clear context',
  clear: 'Clear',
  attachPage: 'Attach page',
  detachPage: 'Remove page from context',
  clearSelection: 'Clear selection',
  wiki: 'Wiki',
  newPage: 'New page',
  newFolder: 'New folder',
  refresh: 'Refresh',
  settings: 'Settings',
  close: 'Close',
  theme: 'Theme',
  themeLight: 'Light',
  themeDark: 'Dark',
  themeAuto: 'Auto',
  palette: 'Palette',
  language: 'Language',
  langRu: 'Русский',
  langEn: 'English',
  palIndigo: 'Indigo',
  palForest: 'Forest',
  palOcean: 'Ocean',
  palPlum: 'Plum',
  palAmber: 'Amber',
  palRosewood: 'Rose',
  palInk: 'Ink',
  palMatcha: 'Matcha',
  palSky: 'Sky',
  newPageHere: 'New page here',
  newFolderHere: 'New folder here',
  rename: 'Rename',
  delete: 'Delete',
  emptyTree: 'Empty. Create a page.',
  moveToRoot: 'Move to root',
  folderName: 'folder name',
  pageName: 'page name',
  voiceInput: 'Voice input',
  askAssistant: 'Ask the assistant…',
  send: 'Send',
  pickPage: 'Pick a page from the file list',
  saving: 'Saving…',
  saved: 'Saved',
  edit: 'Edit',
  view: 'View',
  copy: 'Copy',
  copied: 'Copied',
  storage: 'Files',
  upload: 'Upload files',
  emptyStorage: 'Empty. Upload a file or send one to the bot.',
  pickFile: 'Pick a file from the list',
  download: 'Download',
  openInTab: 'Open in a new tab',
  fileMissing: 'File not found — it may have been moved or deleted. The list has been refreshed.',
  actions: 'Actions',
  openAssistant: 'Open assistant',
  collapseChat: 'Collapse',
  emptyFolder: 'Empty folder',
  uploadHint: 'Drop files here or upload from your device',
  back: 'Back',
  open: 'Open',
  mcpTitle: 'Agent access (MCP)',
  mcpHint: 'External agents — Claude Code and other MCP clients — can read and update your wiki and tasks.',
  mcpEndpoint: 'URL',
  mcpToken: 'Token',
  mcpCopyCmd: 'Claude Code command',
  mcpRotate: 'Rotate token',
  mcpRotateConfirm: 'The old token will stop working for every connected client. Rotate?',
}

export const t = (k: keyof typeof RU): string => (ru ? RU : EN)[k]

export function confirmDelete(path: string): string {
  return ru ? `Удалить «${path}»?` : `Delete “${path}”?`
}

export function selectedChars(n: number): string {
  return ru ? `выделено ${n}` : `${n} chars selected`
}

// «изменено сегодня / вчера / 5 дн. назад / 12 мар. 2026»
export function updatedAgo(mtime: number): string {
  const then = new Date(mtime * 1000)
  const now = new Date()
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(then)) / 86400000)
  let when: string
  if (days <= 0) when = ru ? 'сегодня' : 'today'
  else if (days === 1) when = ru ? 'вчера' : 'yesterday'
  else if (days < 7) when = ru ? `${days} дн. назад` : `${days} d ago`
  else when = then.toLocaleDateString(ru ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric' })
  return (ru ? 'изменено ' : 'updated ') + when
}

export function formatDay(mtime: number): string {
  return new Date(mtime * 1000).toLocaleDateString(ru ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric' })
}
