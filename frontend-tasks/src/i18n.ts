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
  remove_tag: "Убрать тег",
  tag_placeholder: "＃ тег",
  someday_short: "Потом",
  when: "Когда",
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
  interval: "Интервал",
  less: "Меньше",
  more: "Больше",
  by_schedule: "По расписанию",
  after_completion: "После выполнения",
  done_btn: "Готово",

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
  no_connection: "⚠ Нет связи с ассистентом.",

  // Command palette
  search_tasks: "Поиск задач…",
  nothing_found: "Ничего не найдено",

  // Toasts
  undo: "Отменить",
  toast_done: "Выполнено",
  toast_deleted: "Удалено",

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
  remove_tag: "Remove tag",
  tag_placeholder: "＃ tag",
  someday_short: "Someday",
  when: "When",
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
  interval: "Interval",
  less: "Less",
  more: "More",
  by_schedule: "On schedule",
  after_completion: "After completion",
  done_btn: "Done",

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
  no_connection: "⚠ Can't reach the assistant.",

  search_tasks: "Search tasks…",
  nothing_found: "Nothing found",

  undo: "Undo",
  toast_done: "Completed",
  toast_deleted: "Deleted",

  voice_input: "Voice input",
};

export const t = (k: keyof typeof RU): string => (lang === "ru" ? RU : EN)[k];

/** Month names (nominative, capitalized): calendar header + upcoming group labels. */
export const MONTHS: string[] = lang === "ru"
  ? ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"]
  : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

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

/** «каждую неделю», «каждые 3 дня» / "every week", "every 3 days" (+ after-completion suffix). */
export function repeatPhrase(unit: RepeatRule["unit"], interval: number, afterDone: boolean): string {
  const base = lang === "ru"
    ? (interval === 1 ? RU_EVERY_ONE[unit] : `каждые ${interval} ${ruPlural(interval, RU_FORMS[unit])}`)
    : (interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`);
  if (!afterDone) return base;
  return lang === "ru" ? `${base} после выполнения` : `${base} after completion`;
}
