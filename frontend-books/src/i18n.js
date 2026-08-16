/* ── Язык интерфейса ──
   Как в вики: по умолчанию берём язык браузера, выбор человека держим в localStorage.
   Строка — либо текст, либо функция от подстановок; t() разбирается сама.
   Множественное число у языков разное, поэтому формы лежат отдельным словарём. */

const stored = (() => { try { return localStorage.getItem('books_lang'); } catch { return null; } })();
export const lang = stored === 'ru' || stored === 'en' ? stored
  : (navigator.language || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
export const ru = lang === 'ru';
export const locale = ru ? 'ru-RU' : 'en-US';

export function setLang(l) {
  try { localStorage.setItem('books_lang', l); } catch {}
  location.reload();
}

const RU = {
  /* общее */
  books: 'Книги',
  agent: 'Агент',
  opening: 'открываю…',
  openingBook: 'открываю книгу…',
  parsingBook: 'разбираю книгу…',
  cancel: 'Отмена',
  delete: 'Удалить',
  open: 'Открыть',
  deleted: 'Удалено',
  copied: 'Скопировано',
  copyFailed: 'Скопировать не вышло',

  /* вход */
  authTagline: 'Читалка с агентом. Пароль тот же, что у вики.',
  password: 'Пароль',
  signIn: 'Войти',
  wrongPassword: 'Неверный пароль',
  serverSaid: s => 'Сервер ответил ' + s,
  loginFailed: 'Не вышло',
  sessionExpired: 'Сессия истекла, войди заново',
  signInToAsk: 'Войди, чтобы спросить агента',
  signInToWiki: 'Войди, чтобы отправить в вики',

  /* полка */
  statsTitle: 'Статистика чтения',
  addBook: 'Добавить книгу',
  settings: 'Настройки',
  add: 'Добавить',
  shelfEmpty: 'полка пока пустая',
  onShelf: n => n + ' на полке',
  book: 'Книга',
  untitled: 'Без названия',
  continueReading: 'Продолжить',
  reading: 'читаешь',
  wholeShelf: 'Вся полка',
  removeFromShelf: 'Удалить с полки',
  deleteBookQ: title => `Удалить «${title}»? Выписки тоже пропадут.`,
  deleteFailed: 'Сервер не отдал книгу — попробуй ещё',
  notEpubOrPdf: 'Это не epub и не PDF',
  alreadyOnShelf: 'Эта книга уже на полке',
  cantAddBook: 'Не смог добавить книгу',

  /* читалка */
  bookNotOpened: 'Книга не открылась',
  placeNotFound: 'Не нашёл это место в книге',
  bookProgress: 'Прогресс книги',
  pageOf: (p, total) => `${p} из ${total}`,
  pageNo: n => 'стр. ' + n,

  /* ящики */
  searchTitle: 'Поиск',
  tocTitle: 'Оглавление',
  highlightsTitle: 'Выписки',
  allToWikiTitle: 'Собрать всё в вики',
  viewTitle: 'Вид',
  noToc: 'В книге нет оглавления',
  findInBook: 'Искать в книге',
  atLeastThree: 'Хотя бы три буквы',
  searching: 'Ищу по книге…',
  nothingFound: 'Ничего не нашлось',
  noHighlightsYet: 'Пока пусто.<br>Выдели фрагмент в тексте и выбери цвет.',
  noHighlights: 'Выписок пока нет',
  agentReplies: n => n + ' агента',

  /* вид */
  theme: 'Тема',
  themeAuto: 'Как в системе',
  themeLight: 'Светлая',
  themeSepia: 'Сепия',
  themeDark: 'Тёмная',
  pdfFixed: 'Вёрстка PDF зашита в файл — страница просто подгоняется под экран.',
  fontSize: 'Кегль',
  margins: 'Поля',
  marginsHint: 'шире поля — короче строка, легче глазу',
  marginNarrow: 'Узкие',
  marginNormal: 'Обычные',
  marginWide: 'Широкие',
  layout: 'Разметка',
  layoutHint: 'страницами — как в бумажной книге; лентой — как в вебе',
  layoutPaged: 'Страницы',
  layoutScrolled: 'Лента',
  spread: 'Разворот',
  spreadHint: 'на широком экране — две страницы',
  spreadAuto: 'Авто',
  spreadSingle: 'Одна',

  /* настройки */
  language: 'Язык',
  syncNow: 'Синхронизировать',
  syncing: 'Синхронизирую…',
  syncOk: 'Прогресс сведён',
  syncFailed: 'Не вышло — нет связи',
  progress: 'Прогресс',
  syncedAt: w => 'сведён ' + w,
  neverSynced: 'пока не сводился',
  signOut: 'Выйти',
  signedIn: 'вошли, вопросы к агенту работают',
  signedOut: 'не вошли — агент недоступен',
  storageNote: 'Файлы книг лежат на этом устройстве.<br>'
    + 'Позиция и выписки сводятся через сервер — на всех устройствах одно место в книге.',

  /* выделение и шторка */
  translate: 'Перевести',
  explain: 'Объяснить',
  ask: 'Спросить',
  toWiki: 'В вики',
  toHighlights: 'В выписки',
  savedToHighlights: 'Сохранено в выписки',
  highlightDeleted: 'Выписка удалена',
  ownNote: 'Своя заметка…',
  refine: 'Уточнить…',
  askAboutFragment: 'Напиши вопрос про этот фрагмент',
  waitForAnswer: 'Дождись ответа',
  thinking: 'думает…',
  agentUnavailable: 'Агент недоступен',
  error: 'Ошибка',
  titleTranslate: 'Перевод',
  titleExplain: 'Объяснение',
  titleAsk: 'Вопрос',
  chipsTranslate: ['Проще', 'Дословно', 'Разбери термины'],
  chipsExplain: ['Пример', 'Короче', 'А контраргумент?'],
  chipsAsk: ['Подробнее', 'Где ещё об этом', 'Не согласен'],

  /* что делает агент */
  toolSearchBook: 'ищет по книге…',
  toolReadBook: 'читает книгу…',
  toolHighlights: 'смотрит выписки…',
  toolShelf: 'смотрит полку…',
  toolWikiSearch: 'ищет в вики…',
  toolRead: what => 'читает ' + what + '…',
  toolPage: 'страницу',
  toolWikiWrite: 'пишет в вики…',
  toolWeb: 'смотрит в интернете…',
  toolBusy: 'работает…',

  /* связь */
  agentSilent: 'Агент не отвечает',
  agentNoLink: 'Нет связи с агентом',
  linkLost: 'Связь оборвалась',

  /* цвета выписок */
  colorImp: 'Важное',
  colorNo: 'Не согласен',
  colorQ: 'Вопрос',
  colorWiki: 'В вики',
  colorNice: 'Красиво сказано',

  /* статистика */
  statsHead: 'Чтение',
  statsSub: 'сколько и когда',
  counting: 'Считаю…',
  statsFailed: 'Статистика не открылась.<br>Похоже, нет связи с сервером.',
  statsEmpty: 'Пока нечего показывать.<br>'
    + 'Открой книгу — и через пару вечеров здесь будет календарь чтения.',
  minutes: m => m + ' мин',
  hoursN: h => h + ' ч',
  record: n => 'рекорд — ' + n,
  isRecord: 'это и есть рекорд',
  halfYear: 'за полгода',
  bestDay: h => 'лучший день — ' + h,
  onAverage: h => 'в среднем ' + h,
  calendar: 'Календарь',
  weekdays: ['', 'Вт', '', 'Чт', '', 'Сб', ''],
  months: ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  dayMonth: (d, m) => d + ' ' + m,
  notRead: 'не читали',
  less: 'меньше',
  more: 'больше',
  pctOfBook: p => p + '% книги',
  byBooks: 'По книгам',
  noTimeCounted: 'без учёта времени',
  readPct: p => 'прочитано ' + p + '%',

  /* прошедшее время */
  justNow: 'только что',
  ago: s => s + ' назад',
};

const EN = {
  books: 'Books',
  agent: 'Assistant',
  opening: 'opening…',
  openingBook: 'opening the book…',
  parsingBook: 'reading the file…',
  cancel: 'Cancel',
  delete: 'Delete',
  open: 'Open',
  deleted: 'Deleted',
  copied: 'Copied',
  copyFailed: 'Could not copy',

  authTagline: 'A reader with an assistant. Same password as the wiki.',
  password: 'Password',
  signIn: 'Sign in',
  wrongPassword: 'Wrong password',
  serverSaid: s => 'Server said ' + s,
  loginFailed: 'Failed',
  sessionExpired: 'Session expired, sign in again',
  signInToAsk: 'Sign in to ask the assistant',
  signInToWiki: 'Sign in to send this to the wiki',

  statsTitle: 'Reading stats',
  addBook: 'Add a book',
  settings: 'Settings',
  add: 'Add',
  shelfEmpty: 'the shelf is empty',
  onShelf: n => n + ' on the shelf',
  book: 'Book',
  untitled: 'Untitled',
  continueReading: 'Continue',
  reading: 'reading',
  wholeShelf: 'All books',
  removeFromShelf: 'Remove from shelf',
  deleteBookQ: title => `Delete “${title}”? Its highlights will go too.`,
  deleteFailed: 'The server kept the book — try again',
  notEpubOrPdf: 'That is neither epub nor PDF',
  alreadyOnShelf: 'This book is already on the shelf',
  cantAddBook: 'Could not add the book',

  bookNotOpened: 'The book did not open',
  placeNotFound: 'Could not find that place in the book',
  bookProgress: 'Progress',
  pageOf: (p, total) => `${p} of ${total}`,
  pageNo: n => 'p. ' + n,

  searchTitle: 'Search',
  tocTitle: 'Contents',
  highlightsTitle: 'Highlights',
  allToWikiTitle: 'Collect everything into the wiki',
  viewTitle: 'View',
  noToc: 'This book has no table of contents',
  findInBook: 'Search in the book',
  atLeastThree: 'Three letters at least',
  searching: 'Searching the book…',
  nothingFound: 'Nothing found',
  noHighlightsYet: 'Nothing yet.<br>Select a passage and pick a color.',
  noHighlights: 'No highlights yet',
  agentReplies: n => n + ' from the assistant',

  theme: 'Theme',
  themeAuto: 'System',
  themeLight: 'Light',
  themeSepia: 'Sepia',
  themeDark: 'Dark',
  pdfFixed: 'A PDF is laid out once and for all — the page is just fitted to the screen.',
  fontSize: 'Text size',
  margins: 'Margins',
  marginsHint: 'wider margins — shorter lines, easier on the eye',
  marginNarrow: 'Narrow',
  marginNormal: 'Normal',
  marginWide: 'Wide',
  layout: 'Layout',
  layoutHint: 'pages — like a paper book; scroll — like the web',
  layoutPaged: 'Pages',
  layoutScrolled: 'Scroll',
  spread: 'Spread',
  spreadHint: 'two pages on a wide screen',
  spreadAuto: 'Auto',
  spreadSingle: 'Single',

  language: 'Language',
  syncNow: 'Sync now',
  syncing: 'Syncing…',
  syncOk: 'Progress merged',
  syncFailed: 'No luck — no connection',
  progress: 'Progress',
  syncedAt: w => 'merged ' + w,
  neverSynced: 'never merged yet',
  signOut: 'Sign out',
  signedIn: 'signed in, the assistant answers',
  signedOut: 'signed out — the assistant is unavailable',
  storageNote: 'Book files live on this device.<br>'
    + 'Position and highlights go through the server — the same place in the book everywhere.',

  translate: 'Translate',
  explain: 'Explain',
  ask: 'Ask',
  toWiki: 'To wiki',
  toHighlights: 'Keep',
  savedToHighlights: 'Saved to highlights',
  highlightDeleted: 'Highlight deleted',
  ownNote: 'Your own note…',
  refine: 'Follow up…',
  askAboutFragment: 'Type your question about this passage',
  waitForAnswer: 'Wait for the answer',
  thinking: 'thinking…',
  agentUnavailable: 'The assistant is unavailable',
  error: 'Error',
  titleTranslate: 'Translation',
  titleExplain: 'Explanation',
  titleAsk: 'Question',
  chipsTranslate: ['Simpler', 'Literally', 'Unpack the terms'],
  chipsExplain: ['Example', 'Shorter', 'Any counterargument?'],
  chipsAsk: ['More detail', 'Where else about this', 'I disagree'],

  toolSearchBook: 'searching the book…',
  toolReadBook: 'reading the book…',
  toolHighlights: 'looking at highlights…',
  toolShelf: 'looking at the shelf…',
  toolWikiSearch: 'searching the wiki…',
  toolRead: what => 'reading ' + what + '…',
  toolPage: 'a page',
  toolWikiWrite: 'writing to the wiki…',
  toolWeb: 'looking it up online…',
  toolBusy: 'working…',

  agentSilent: 'The assistant is not responding',
  agentNoLink: 'No connection to the assistant',
  linkLost: 'Connection lost',

  colorImp: 'Important',
  colorNo: 'Disagree',
  colorQ: 'Question',
  colorWiki: 'To wiki',
  colorNice: 'Well put',

  statsHead: 'Reading',
  statsSub: 'how much and when',
  counting: 'Counting…',
  statsFailed: 'Stats did not open.<br>Looks like there is no connection to the server.',
  statsEmpty: 'Nothing to show yet.<br>'
    + 'Open a book — in a couple of evenings a reading calendar will appear here.',
  minutes: m => m + ' min',
  hoursN: h => h + ' h',
  record: n => 'best — ' + n,
  isRecord: 'this is the record',
  halfYear: 'in six months',
  bestDay: h => 'best day — ' + h,
  onAverage: h => 'on average ' + h,
  calendar: 'Calendar',
  weekdays: ['', 'Tue', '', 'Thu', '', 'Sat', ''],
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  dayMonth: (d, m) => m + ' ' + d,
  notRead: 'no reading',
  less: 'less',
  more: 'more',
  pctOfBook: p => p + '% of the book',
  byBooks: 'By book',
  noTimeCounted: 'time not counted',
  readPct: p => p + '% read',

  justNow: 'just now',
  ago: s => s + ' ago',
};

const DICT = ru ? RU : EN;

/** Строка по ключу; с аргументами — подставляет их в шаблон. */
export function t(k, ...args) {
  const v = DICT[k];
  return typeof v === 'function' ? v(...args) : v === undefined ? k : v;
}

/* Формы множественного числа: у русского их три, у английского две. Хранятся здесь же,
   чтобы вызывающий код не знал ни про правила языка, ни про количество форм. */
const FORMS = {
  ru: {
    books: ['книга', 'книги', 'книг'],
    highlights: ['выписка', 'выписки', 'выписок'],
    finds: ['находка', 'находки', 'находок'],
    replies: ['ответ', 'ответа', 'ответов'],
    minutesAgo: ['минуту', 'минуты', 'минут'],
    hoursAgo: ['час', 'часа', 'часов'],
    dayStreak: ['день подряд', 'дня подряд', 'дней подряд'],
    dayWithBook: ['день с книгой', 'дня с книгой', 'дней с книгой'],
  },
  en: {
    books: ['book', 'books'],
    highlights: ['highlight', 'highlights'],
    finds: ['match', 'matches'],
    replies: ['reply', 'replies'],
    minutesAgo: ['minute', 'minutes'],
    hoursAgo: ['hour', 'hours'],
    dayStreak: ['day in a row', 'days in a row'],
    dayWithBook: ['day with a book', 'days with a book'],
  },
};

/** Слово в нужной форме, без числа: «дня подряд», 'days in a row'. */
export function form(n, key) {
  const f = FORMS[lang][key];
  if (!ru) return f[n === 1 ? 0 : 1];
  const m = n % 100, k = n % 10;
  return m > 10 && m < 20 ? f[2] : k === 1 ? f[0] : k > 1 && k < 5 ? f[1] : f[2];
}

/** Число со словом: «5 выписок», '5 highlights'. */
export const plural = (n, key) => n + ' ' + form(n, key);

/* ── Промпты агенту ──
   Агент отвечает на языке вопроса, поэтому язык интерфейса задаёт и язык разбора:
   английский интерфейс не должен получать в ответ русский пересказ главы. */
export const PROMPT = ru ? {
  reading: (title, author) => `Я читаю книгу «${title}»${author ? ` (${author})` : ''}`,
  chapter: c => `, глава «${c}»`,
  translate: 'Переведи выделенный фрагмент на русский. Только перевод, без вступлений и без пояснений.',
  explain: 'Объясни выделенный фрагмент: что автор имеет в виду, зачем это здесь, к чему ведёт. '
    + 'Коротко — два-три абзаца, без пересказа очевидного.',
  askDefault: 'Что скажешь про этот фрагмент?',
  fragment: 'Выделенный фрагмент:',
  around: 'Текст вокруг — для контекста, отвечать по нему не надо:',
  answerIn: 'Ответь по-русски, без предисловий.',
  askLabelTranslate: 'Переведи этот фрагмент',
  askLabelExplain: 'Объясни этот фрагмент',
  saveQuote: (title, author) => `Сохрани выписку из книги «${title}»${author ? ` (${author})` : ''}`,
  quote: 'Цитата:',
  myNote: 'Моя заметка к ней:',
  ourTalk: 'Наш разговор о ней:',
  putInWiki: 'Положи в подходящую страницу вики (или заведи новую про эту книгу), '
    + 'оформи цитату аккуратно и ответь одной строкой — куда положил.',
  saveToWiki: 'Сохрани в вики',
  me: 'Я: ',
  you: 'Ты: ',
  agentSaid: 'Агент: ',
  myNoteInline: note => `Моя заметка: ${note}`,
  collectPage: (title, author) => `Собери страницу в вики по книге «${title}»${author ? ` (${author})` : ''}.`,
  myHighlights: 'Мои выписки:',
  groupThem: 'Сгруппируй по смыслу, а не по цвету, добавь короткое вступление своими словами и '
    + 'ответь одной строкой — куда положил.',
  allHighlights: 'Все выписки из книги',
  fromBook: n => n + ' из книги',
} : {
  reading: (title, author) => `I am reading “${title}”${author ? ` (${author})` : ''}`,
  chapter: c => `, chapter “${c}”`,
  translate: 'Translate the selected passage into English. Translation only, no preamble, no notes.',
  explain: 'Explain the selected passage: what the author means, why it is here, where it leads. '
    + 'Keep it to two or three paragraphs, skip the obvious.',
  askDefault: 'What do you make of this passage?',
  fragment: 'The selected passage:',
  around: 'Surrounding text, for context only — no need to answer about it:',
  answerIn: 'Answer in English, no preamble.',
  askLabelTranslate: 'Translate this passage',
  askLabelExplain: 'Explain this passage',
  saveQuote: (title, author) => `Save a highlight from “${title}”${author ? ` (${author})` : ''}`,
  quote: 'The quote:',
  myNote: 'My note on it:',
  ourTalk: 'Our conversation about it:',
  putInWiki: 'Put it on a fitting wiki page (or start a new one about this book), '
    + 'format the quote neatly and answer in one line — where you put it.',
  saveToWiki: 'Save to the wiki',
  me: 'Me: ',
  you: 'You: ',
  agentSaid: 'Assistant: ',
  myNoteInline: note => `My note: ${note}`,
  collectPage: (title, author) => `Build a wiki page about “${title}”${author ? ` (${author})` : ''}.`,
  myHighlights: 'My highlights:',
  groupThem: 'Group them by meaning rather than by color, add a short introduction in your own words '
    + 'and answer in one line — where you put it.',
  allHighlights: 'All highlights from the book',
  fromBook: n => n + ' from the book',
};

/* ── Статическая разметка ──
   index.html написан по-русски и остаётся читаемым сам по себе; ключи висят атрибутами,
   и при английском языке текст подменяется до первого кадра приложения. */
export function applyDom(root = document) {
  document.documentElement.lang = lang;
  document.title = t('books');
  root.querySelectorAll('[data-t]').forEach(n => { n.textContent = t(n.dataset.t); });
  root.querySelectorAll('[data-t-ph]').forEach(n => { n.placeholder = t(n.dataset.tPh); });
  root.querySelectorAll('[data-t-title]').forEach(n => { n.title = t(n.dataset.tTitle); });
  root.querySelectorAll('[data-t-aria]').forEach(n => { n.setAttribute('aria-label', t(n.dataset.tAria)); });
  if (!ru) {
    // Имя приложения на домашнем экране — из манифеста, а он статический файл.
    const link = document.querySelector('link[rel=manifest]');
    if (link) link.href = 'manifest.en.webmanifest';
    const title = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (title) title.content = t('books');
  }
}
