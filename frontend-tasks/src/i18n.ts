import type { RepeatRule } from "./types";

export type Lang = "ru" | "en";

const stored = localStorage.getItem("tasks_lang");
export const lang: Lang =
  stored === "ru" || stored === "en"
    ? stored
    : navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";

export function setLang(l: Lang) {
  localStorage.setItem("tasks_lang", l);
  location.reload();
}

/** BCP-47 locale for toLocaleDateString and friends. */
export const locale = lang === "ru" ? "ru-RU" : "en-US";

const RU = {
  // Views
  view_inbox: "Входящие",
  view_today: "Сегодня",
  view_upcoming: "Предстоящие",
  view_anytime: "В любое время",
  view_someday: "Когда-нибудь",
  view_logbook: "Журнал",

  // App / auth / topbar
  app_title: "Задачи",
  password: "Пароль",
  sign_in: "Войти",
  wrong_password: "Неверный пароль",
  menu: "Меню",
  search: "Поиск",
  assistant: "Ассистент",
  project: "Проект",
  tag: "Тег",

  // Empty states
  empty_today: "На сегодня ничего не запланировано.",
  empty_inbox: "Входящие пусты. Сюда попадают задачи без проекта и даты.",
  empty_upcoming: "Нет предстоящих задач с датой.",
  empty_anytime: "Нет задач «когда-нибудь».",
  empty_someday: "Список «когда-то потом» пуст.",
  empty_logbook: "Журнал пуст.",
  empty_project: "В проекте пока нет задач.",
  empty_tag: "Нет открытых задач с этим тегом.",
  empty_generic: "Пусто",

  // Kickers
  kicker_inbox: "Несортированные мысли",
  kicker_upcoming: "Календарь",
  kicker_anytime: "Всё, что можно сделать",
  kicker_someday: "Может быть, однажды",
  kicker_logbook: "Всё, что ты завершил",

  // Dates / groups
  tomorrow: "Завтра",
  yesterday: "Вчера",
  overdue: "Просрочено",
  done_today: "Готово сегодня",
  prev_month: "Предыдущий месяц",
  next_month: "Следующий месяц",

  // Task list
  area: "Область",
  add_heading: "Раздел",
  heading_name: "Название раздела",
  new_task: "Новая задача",
  no_area: "Без области",
  delete_heading: "Удалить раздел",

  // Task detail / editing
  notes: "Заметки",
  checklist_item: "Пункт чек-листа",
  delete: "Удалить",
  cancel: "Отмена",
  confirm_delete: "Удалить задачу?",
  confirm_delete_area: "Удалить область? Её проекты и задачи останутся",
  areas: "Области",
  move_to: "Переместить",
  badge_title: "Бейдж на иконке",
  badge_allow: "Разрешить",
  badge_on: "Включён",
  badge_denied: "Запрещён в настройках системы",
  new_list: "Новый список",
  new_project_hint: "Цель с финишем и шагами",
  new_area_hint: "Сфера жизни: Работа, Дом…",
  empty_area: "Пока пусто. Перетащи сюда проекты и задачи этой сферы",
  confirm_delete_heading: "Удалить раздел?",
  remove_tag: "Убрать тег",
  tag_placeholder: "＃ тег",
  someday_short: "Потом",
  when: "Когда",
  postponed: "Переносов",
  created: "создана",
  tags: "Теги",
  checklist: "Чек-лист",
  deadline: "Дедлайн",
  repeat: "Повтор",
  remove: "Убрать",
  clear_deadline: "Убрать дедлайн",
  no_project: "Без проекта",
  create: "Создать",
  ignore_hint: "Не распознавать",
  untitled: "Без названия",
  mark_done: "Выполнить",
  mark_open: "Снять отметку",

  // Repeat popover
  unit_day: "День",
  unit_week: "Неделя",
  unit_month: "Месяц",
  unit_year: "Год",
  interval: "Каждые",
  less: "Меньше",
  more: "Больше",
  by_schedule: "По расписанию",
  after_completion: "После выполнения",
  done_btn: "Готово",
  by_monthday: "По числу",
  by_weekday: "По дню недели",
  last_day: "Последний",
  starts: "Начиная с",
  ends: "Заканчивается",
  end_never: "Никогда",
  end_after: "После",
  end_on: "До даты",
  times_short: "раз",
  next_up: "Дальше",
  view_repeats: "Повторы",
  empty_repeats: "Повторяющихся задач пока нет. Включи повтор в любой задаче — она станет появляться сама.",
  kicker_repeats: "Правила, по которым задачи возвращаются",
  repeats_section: "Повторяется",
  repeat_template: "Шаблон повтора",
  edit_repeat: "Изменить повтор",
  skip_occurrence: "Пропустить",
  confirm_delete_repeat: "Удалить повтор?",
  confirm_delete_repeat_hint: "Будущие копии тоже исчезнут",

  // Sidebar
  close_menu: "Закрыть меню",
  no_projects_yet: "Пока без проектов",
  projects: "Проекты",
  project_name: "Название проекта",
  area_name: "Название области",
  new_project: "Новый проект",
  new_area: "Новая область",
  settings: "Настройки",

  // Settings
  close: "Закрыть",
  theme: "Тема",
  theme_light: "Светлая",
  theme_dark: "Тёмная",
  theme_auto: "Авто",
  palette: "Расцветка",
  language: "Язык",
  lang_ru: "Русский",
  lang_en: "English",
  pal_indigo: "Индиго",
  pal_forest: "Лес",
  pal_ocean: "Океан",
  pal_plum: "Слива",
  pal_amber: "Янтарь",
  pal_rosewood: "Роза",
  pal_ink: "Тушь",
  pal_matcha: "Матча",
  pal_sky: "Небо",

  // Chat
  open_assistant: "Открыть ассистента",
  clear: "Очистить",
  clear_context: "Очистить контекст",
  collapse: "Свернуть",
  send: "Отправить",
  ask_assistant: "Спросите ассистента…",
  chat_empty_1: "Спросите ассистента про ваши задачи и планы.",
  chat_empty_2: "Напр.: «что у меня на сегодня?», «перенеси отчёт на пятницу».",
  load_failed: "Не удалось загрузить задачи",
  retry: "Повторить",
  no_connection: "Нет связи с ассистентом.",

  // Command palette
  search_tasks: "Поиск задач…",
  nothing_found: "Ничего не найдено",

  // Toasts
  undo: "Отменить",
  toast_done: "Выполнено",
  toast_deleted: "Удалено",

  // MCP
  mcp_title: "Доступ для агентов (MCP)",
  mcp_hint: "Внешние агенты — Claude Code и другие MCP-клиенты — могут читать и пополнять задачи и вики.",
  mcp_endpoint: "Адрес",
  mcp_token: "Токен",
  mcp_copy_cmd: "Команда для Claude Code",
  mcp_rotate: "Перевыпустить токен",
  mcp_rotate_confirm: "Старый токен перестанет работать у всех подключённых клиентов. Перевыпустить?",
  copy: "Скопировать",
  copied: "Скопировано",

  // Misc
  voice_input: "Голосовой ввод",
} as const;

const EN: Record<keyof typeof RU, string> = {
  view_inbox: "Inbox",
  view_today: "Today",
  view_upcoming: "Upcoming",
  view_anytime: "Anytime",
  view_someday: "Someday",
  view_logbook: "Logbook",

  app_title: "Tasks",
  password: "Password",
  sign_in: "Sign in",
  wrong_password: "Wrong password",
  menu: "Menu",
  search: "Search",
  assistant: "Assistant",
  project: "Project",
  tag: "Tag",

  empty_today: "Nothing planned for today.",
  empty_inbox: "Inbox is empty. Tasks without a project or date land here.",
  empty_upcoming: "No upcoming tasks with a date.",
  empty_anytime: "No anytime tasks.",
  empty_someday: "The someday list is empty.",
  empty_logbook: "The logbook is empty.",
  empty_project: "No tasks in this project yet.",
  empty_tag: "No open tasks with this tag.",
  empty_generic: "Empty",

  kicker_inbox: "Unsorted thoughts",
  kicker_upcoming: "Calendar",
  kicker_anytime: "Everything you could do",
  kicker_someday: "Maybe one day",
  kicker_logbook: "Everything you've completed",

  tomorrow: "Tomorrow",
  yesterday: "Yesterday",
  overdue: "Overdue",
  done_today: "Done today",
  prev_month: "Previous month",
  next_month: "Next month",

  area: "Area",
  add_heading: "Heading",
  heading_name: "Heading name",
  new_task: "New task",
  no_area: "No area",
  delete_heading: "Delete heading",

  notes: "Notes",
  checklist_item: "Checklist item",
  delete: "Delete",
  cancel: "Cancel",
  confirm_delete: "Delete task?",
  confirm_delete_area: "Delete area? Its projects and tasks will stay",
  areas: "Areas",
  move_to: "Move to",
  badge_title: "Icon badge",
  badge_allow: "Allow",
  badge_on: "On",
  badge_denied: "Blocked in system settings",
  new_list: "New list",
  new_project_hint: "A goal with an end and steps",
  new_area_hint: "A sphere of life: Work, Home…",
  empty_area: "Nothing here yet. Drag this sphere's projects and tasks in",
  confirm_delete_heading: "Delete heading?",
  remove_tag: "Remove tag",
  tag_placeholder: "＃ tag",
  someday_short: "Someday",
  when: "When",
  postponed: "Postponed",
  created: "created",
  tags: "Tags",
  checklist: "Checklist",
  deadline: "Deadline",
  repeat: "Repeat",
  remove: "Remove",
  clear_deadline: "Remove deadline",
  no_project: "No project",
  create: "Create",
  ignore_hint: "Dismiss suggestion",
  untitled: "Untitled",
  mark_done: "Complete",
  mark_open: "Mark as incomplete",

  unit_day: "Day",
  unit_week: "Week",
  unit_month: "Month",
  unit_year: "Year",
  interval: "Every",
  less: "Less",
  more: "More",
  by_schedule: "On schedule",
  after_completion: "After completion",
  done_btn: "Done",
  by_monthday: "By date",
  by_weekday: "By weekday",
  last_day: "Last",
  starts: "Starts",
  ends: "Ends",
  end_never: "Never",
  end_after: "After",
  end_on: "On date",
  times_short: "times",
  next_up: "Next",
  view_repeats: "Repeating",
  empty_repeats: "No repeating tasks yet. Turn on repeat in any task and it will come back on its own.",
  kicker_repeats: "Rules that bring tasks back",
  repeats_section: "Repeats",
  repeat_template: "Repeat template",
  edit_repeat: "Edit repeat",
  skip_occurrence: "Skip",
  confirm_delete_repeat: "Delete repeat?",
  confirm_delete_repeat_hint: "Future occurrences will go too",

  close_menu: "Close menu",
  no_projects_yet: "No projects yet",
  projects: "Projects",
  project_name: "Project name",
  area_name: "Area name",
  new_project: "New project",
  new_area: "New area",
  settings: "Settings",

  close: "Close",
  theme: "Theme",
  theme_light: "Light",
  theme_dark: "Dark",
  theme_auto: "Auto",
  palette: "Palette",
  language: "Language",
  lang_ru: "Русский",
  lang_en: "English",
  pal_indigo: "Indigo",
  pal_forest: "Forest",
  pal_ocean: "Ocean",
  pal_plum: "Plum",
  pal_amber: "Amber",
  pal_rosewood: "Rose",
  pal_ink: "Ink",
  pal_matcha: "Matcha",
  pal_sky: "Sky",

  open_assistant: "Open assistant",
  clear: "Clear",
  clear_context: "Clear context",
  collapse: "Collapse",
  send: "Send",
  ask_assistant: "Ask the assistant…",
  chat_empty_1: "Ask the assistant about your tasks and plans.",
  chat_empty_2: "E.g. “what's on for today?”, “move the report to Friday”.",
  load_failed: "Could not load tasks",
  retry: "Retry",
  no_connection: "Can't reach the assistant.",

  search_tasks: "Search tasks…",
  nothing_found: "Nothing found",

  undo: "Undo",
  toast_done: "Completed",
  toast_deleted: "Deleted",

  mcp_title: "Agent access (MCP)",
  mcp_hint: "External agents — Claude Code and other MCP clients — can read and update your tasks and wiki.",
  mcp_endpoint: "URL",
  mcp_token: "Token",
  mcp_copy_cmd: "Claude Code command",
  mcp_rotate: "Rotate token",
  mcp_rotate_confirm: "The old token will stop working for every connected client. Rotate?",
  copy: "Copy",
  copied: "Copied",

  voice_input: "Voice input",
};

export const t = (k: keyof typeof RU): string => (lang === "ru" ? RU : EN)[k];

/** Month names (nominative, capitalized): calendar header + upcoming group labels. */
export const MONTHS: string[] = lang === "ru"
  ? ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"]
  : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Сокращённые месяцы: сетка выбора месяца в правиле повтора. */
export const MONTHS_SHORT: string[] = MONTHS.map((m) => m.slice(0, 3));

/** Weekday headers for the calendar grid, Monday first. */
export const WEEKDAYS_SHORT: string[] = lang === "ru"
  ? ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
  : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Progress-ring tooltip: «Готово 3 из 7» / "3 of 7 done". */
export const doneOfTotal = (done: number, total: number): string =>
  lang === "ru" ? `Готово ${done} из ${total}` : `${done} of ${total} done`;

/** Logbook kicker: «5 за неделю · 12 за месяц» / "5 this week · 12 this month". */
export const logbookStats = (week: number, month: number): string =>
  lang === "ru" ? `${week} за неделю · ${month} за месяц` : `${week} this week · ${month} this month`;

// Russian plural forms: [1, 2–4, 5+]
const ruPlural = (n: number, [one, few, many]: [string, string, string]): string => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/** «вчера» / «5 дней назад» — how long a task has been overdue. */
export const agoLabel = (days: number): string =>
  lang === "ru"
    ? days <= 1 ? "вчера" : `${days} ${ruPlural(days, ["день", "дня", "дней"])} назад`
    : days <= 1 ? "yesterday" : `${days} days ago`;

const RU_FORMS: Record<RepeatRule["unit"], [string, string, string]> = {
  day: ["день", "дня", "дней"],
  week: ["неделю", "недели", "недель"],
  month: ["месяц", "месяца", "месяцев"],
  year: ["год", "года", "лет"],
};
const RU_EVERY_ONE: Record<RepeatRule["unit"], string> = {
  day: "каждый день",
  week: "каждую неделю",
  month: "каждый месяц",
  year: "каждый год",
};

/** Родительный падеж: «12 марта» — для дат внутри фразы повтора. */
export const MONTHS_GEN: string[] = lang === "ru"
  ? ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]
  : MONTHS;

/** «12 авг» — короткая дата для чипов и предпросмотра. */
export const shortDate = (isoDate: string): string => {
  const [y, m, d] = isoDate.split("-").map(Number);
  const month = MONTHS_GEN[m - 1].slice(0, lang === "ru" ? 3 : 3);
  const year = new Date().getFullYear() === y ? "" : ` ${y}`;
  return `${d} ${month}${year}`;
};

// «во вторую среду»: русский требует согласования по роду дня недели, иначе фраза
// звучит как машинный перевод. Род по ISO-номеру дня: пн/вт/чт — м, ср/пт/сб — ж, вс — с.
const RU_ORDINAL: Record<"m" | "f" | "n", Record<number, string>> = {
  m: { 1: "первый", 2: "второй", 3: "третий", 4: "четвёртый", [-1]: "последний" },
  f: { 1: "первую", 2: "вторую", 3: "третью", 4: "четвёртую", [-1]: "последнюю" },
  n: { 1: "первое", 2: "второе", 3: "третье", 4: "четвёртое", [-1]: "последнее" },
};
const RU_GENDER: ("m" | "f" | "n")[] = ["m", "m", "m", "f", "m", "f", "f", "n"];
const RU_WEEKDAY_ACC = ["", "понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];
const EN_ORDINALS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };
const EN_WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** «во второй вторник» / "on the second Tuesday". */
export const nthPhrase = (ordinal: number, weekday: number): string => {
  if (lang !== "ru") return `on the ${EN_ORDINALS[ordinal]} ${EN_WEEKDAYS[weekday]}`;
  const word = RU_ORDINAL[RU_GENDER[weekday]][ordinal];
  return `${word.startsWith("в") ? "во" : "в"} ${word} ${RU_WEEKDAY_ACC[weekday]}`;
};

/** Короткая подпись переключателя порядка: «2-й» / "2nd". */
export const ordinalLabel = (n: number): string =>
  n === -1 ? (lang === "ru" ? "Посл." : "Last") : lang === "ru" ? `${n}-й` : `${n}${["st", "nd", "rd", "th"][n - 1]}`;

/** Человеческое описание правила: «по вт и чт», «каждый месяц, 15 числа · до 31 дек». */
export function repeatPhrase(rule: RepeatRule, short = false): string {
  // Снятый повтор доезжает до чипа как пустой объект (так его убирают на сервере) —
  // фразы у него нет, и падать на этом нельзя.
  if (!rule?.unit) return "";
  const { unit, interval } = rule;
  const ru = lang === "ru";
  const every = interval === 1
    ? (ru ? RU_EVERY_ONE[unit] : `every ${unit}`)
    : (ru ? `каждые ${interval} ${ruPlural(interval, RU_FORMS[unit])}` : `every ${interval} ${unit}s`);

  let base = every;
  if (unit === "week" && rule.weekdays?.length) {
    const names = [...rule.weekdays].sort((a, b) => a - b).map((d) => WEEKDAYS_SHORT[d - 1].toLowerCase());
    const days = ru ? `по ${names.join(", ")}` : `on ${names.join(", ")}`;
    base = interval === 1 ? days : `${every}, ${days}`;
  } else if (unit === "month" || unit === "year") {
    let when = "";
    if (rule.nth) when = nthPhrase(rule.nth[0], rule.nth[1]);
    else if (rule.monthday === "last") when = ru ? "в последний день" : "on the last day";
    else if (rule.monthday) {
      when = unit === "year"
        ? (ru ? `${rule.monthday} ${MONTHS_GEN[(rule.month ?? 1) - 1]}` : `on ${MONTHS[(rule.month ?? 1) - 1]} ${rule.monthday}`)
        : (ru ? `${rule.monthday} числа` : `on the ${rule.monthday}th`);
    }
    if (when) base = `${every}, ${when}`;
  }

  if (rule.mode === "done") base = ru ? `${every} после выполнения` : `${every} after completion`;
  if (short) return base;

  if (rule.end && "after" in rule.end) {
    base += ru ? ` · ${rule.end.after} ${ruPlural(rule.end.after, ["раз", "раза", "раз"])}` : ` · ${rule.end.after} times`;
  } else if (rule.end && "on" in rule.end) {
    base += ru ? ` · до ${shortDate(rule.end.on)}` : ` · until ${shortDate(rule.end.on)}`;
  }
  return base;
}

/** «следующая 12 авг» — подпись под правилом и в строке шаблона. */
export const nextLabel = (isoDate: string): string =>
  lang === "ru" ? `следующая ${shortDate(isoDate)}` : `next ${shortDate(isoDate)}`;
