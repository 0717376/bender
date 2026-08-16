import hashlib
import os

# --- Paths ---
WIKI_DIR = os.path.abspath(os.environ.get("WIKI_DIR", "/app/content"))
# Удалённые страницы лежат здесь, а не стираются: точка в начале прячет папку
# от дерева, поиска и наблюдателя за файлами.
WIKI_TRASH = ".trash"
DATA_DIR = os.path.abspath(os.environ.get("DATA_DIR", "/app/data"))
# Personal file storage: plain folders on disk, independent of the wiki.
FILES_DIR = os.path.abspath(os.environ.get("FILES_DIR", "/app/files"))
FILES_INBOX = "Входящие"
FILES_TRASH = ".trash"
FILES_MAX_UPLOAD = int(os.environ.get("FILES_MAX_UPLOAD", str(500 * 1024 * 1024)))
# Библиотека читалки: epub-файлы и их производные, отдельно от вики и хранилища.
BOOKS_DIR = os.path.abspath(os.environ.get("BOOKS_DIR", "/app/books"))
BOOKS_TRASH = ".trash"
BOOKS_MAX_UPLOAD = int(os.environ.get("BOOKS_MAX_UPLOAD", str(200 * 1024 * 1024)))
SESSION_FILE = os.path.join(DATA_DIR, "session.json")
# Agent persona (SOUL.md-style) — an ordinary wiki page the user can edit;
# re-read on each new session.
PERSONA_NAME = "persona.md"
PERSONA_LEGACY = "Персона ассистента.md"


def persona_path() -> str:
    """Персона — обычная страница вики. Historically кириллицей с пробелом, поэтому
    принимаем оба имени: путь ищется при каждом чтении, и страницу можно
    переименовать на лету, не перезапуская бэкенд. Новую сеем уже слагом."""
    env = os.environ.get("PERSONA_PATH")
    if env:
        return env
    for name in (PERSONA_NAME, PERSONA_LEGACY):
        path = os.path.join(WIKI_DIR, name)
        if os.path.isfile(path):
            return path
    return os.path.join(WIKI_DIR, PERSONA_NAME)
TG_MEDIA_DIR = os.path.join(DATA_DIR, "tg_media")

# --- Auth ---
WIKI_PASSWORD = os.environ.get("WIKI_PASSWORD", "")
# Stable bearer token derived from the password (survives restarts).
AUTH_TOKEN = hashlib.sha256(("wiki:" + WIKI_PASSWORD).encode()).hexdigest()

# --- Agent ---
# На чём ходит агент: подписка Claude (Max) или подписка ChatGPT (Codex). Всё
# остальное — вики, задачи, книги, крон, память, навыки — от движка не зависит.
ENGINE = (os.environ.get("ENGINE", "claude").strip().lower() or "claude")
ENGINES = ("claude", "codex")

# Model alias passed straight to the Claude CLI (sonnet/opus/haiku or full id).
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "sonnet")
# Пусто — модель, которую Codex выбирает сам: список у OpenAI меняется чаще, чем
# выходят наши релизы, и захардкоженное имя устаревает молча.
CODEX_MODEL = os.environ.get("CODEX_MODEL", "")
# Состояние Codex: auth.json, история нитей, кэши. Внутри data/, потому что это том:
# иначе логин умирал бы вместе с контейнером при каждом обновлении.
CODEX_HOME = os.path.abspath(os.environ.get("CODEX_HOME", os.path.join(DATA_DIR, "codex")))
# Наши инструменты Codex видит одним MCP-сервером под этим именем.
CODEX_MCP_NAME = "bender"


def tool_name(group: str, name: str, engine: str = "") -> str:
    """Как инструмент называется для движка. У Claude каждый домен — свой
    внутрипроцессный сервер (mcp__tasks__create_task), у Codex все домены приезжают
    одним HTTP-сервером, поэтому домен переезжает в имя (mcp__bender__tasks_create_task)."""
    if (engine or ENGINE) == "codex":
        return f"mcp__{CODEX_MCP_NAME}__{group}_{name}"
    return f"mcp__{group}__{name}"


class _Names:
    """Подстановка имён инструментов в промпт: {t[tasks.create_task]}."""

    def __init__(self, engine: str):
        self.engine = engine

    def __getitem__(self, key: str) -> str:
        group, _, name = key.partition(".")
        return tool_name(group, name, self.engine)


def render(template: str, engine: str = "") -> str:
    """Подставить в текст имена инструментов текущего движка."""
    return template.format(t=_Names(engine or ENGINE))

# A shared session older than this starts fresh (freshness window) — a
# zombie context dragged for days causes stale dates and bloat. 0 disables.
SESSION_FRESH_HOURS = float(os.environ.get("SESSION_FRESH_HOURS", "6"))

# Background self-review (memory/skill capture). Fires every N turns, not every
# turn; the counter resets when the main agent saves memory itself. Model kept cheap.
REVIEWER_ENABLED = os.environ.get("REVIEWER_ENABLED", "1") not in ("0", "false", "")
REVIEWER_MODEL = os.environ.get("REVIEWER_MODEL", "sonnet")
REVIEWER_EVERY_TURNS = max(1, int(os.environ.get("REVIEWER_EVERY_TURNS", "10")))

# Tools pre-approved so they run headless without prompts (mirrors the old
# --allowedTools list). Anything outside this set is denied, not prompted.
ALLOWED_TOOLS = [
    "Read", "Glob", "Grep", "Write", "Edit",
    "Bash", "BashOutput", "KillShell",
    "WebSearch", "WebFetch", "TodoWrite", "NotebookEdit",
    "Task",  # delegate to subagents (researcher / librarian)
]

# Universal core — shared by every surface. The per-surface skill (below) is layered
# on top of this each turn; the conversation history stays single and shared.
#
# Шаблон, а не готовая строка: имена инструментов у движков разные, и промпт, который
# зовёт несуществующий инструмент, — это молчаливо неработающая функция. Подстановки
# делает base_prompt(engine); {t[группа.имя]} превращается в имя для нужного движка.
_BASE_PROMPT = (
    "Ты — персональный ассистент-агент. У пользователя два рабочих домена, и полный доступ "
    "ко всем инструментам у тебя есть всегда, в любом разговоре:\n"
    "- Вики: личная база знаний из markdown-файлов в рабочей директории "
    "({file_tools}). Страницы вики НИКОГДА не стирай (rm) — "
    "перемещай в {wiki_trash}/ рядом с корнем вики, это корзина.\n"
    "- Задачи: менеджер дел в стиле Things через инструменты {tasks_prefix} "
    "(create_task, list_tasks, update_task, complete_task, list_projects).\n"
    "У тебя ЕСТЬ доступ в интернет: {web}. "
    "Для любой актуальной или фактической информации, которой нет в вики — погода, новости, "
    "курсы, цены, факты, время событий — ИЩИ в вебе и отвечай по найденному. "
    "Никогда не говори, что у тебя «нет доступа к данным» или «нет реального времени»: вместо "
    "этого выполни веб-поиск.\n"
    "Память: когда узнаёшь стабильный факт о пользователе (имя, предпочтения, контекст) — "
    "сохраняй его через {t[memory.remember]} (profile/note/pref). Это переживёт сброс сессии. "
    "Не переспрашивай то, что уже есть в долговременной памяти ниже.\n"
    "Правила памяти: личные факты и предпочтения — в память (remember), знания и документы — "
    "в вики, процедуры — в навыки. Записывай декларативные факты («предпочитает краткие "
    "ответы»), а не команды себе («всегда отвечай кратко»). Уточнение существующей записи — "
    "через {t[memory.update_memory]}, не новой записью поверх. Память мала: не сохраняй "
    "протухающее (номера, реквизиты, даты разовых событий, «сделал X») и не дублируй то, "
    "что записано в вики или задачах, — для истории разговоров есть журнал сессий. "
    "НИКОГДА не говори «запомнил», если не вызвал remember в этом же ходе.\n"
    "Честность: если источники в вебе противоречат друг другу — скажи об этом и дай варианты, "
    "не выбирай один как факт и не досочиняй детали (имена, цифры, события), которых нет в "
    "источнике. Пересказывая результат инструмента, не добавляй полей, которых в нём нет.\n"
    "{subagents}"
    "Расписание: когда нужно «сработать в момент времени и что-то прислать» — «напомни "
    "через 15 минут», «каждый день в 9 пришли сводку», «в пятницу в 18:00» — заводи крон "
    "через {t[cron.create_job]}. Разовое — schedule '15m' или ISO; повтор — 'every 2h' "
    "или cron '0 9 * * *'. Разовые срабатывают один раз и удаляются сами.\n"
    "Навыки: у тебя есть навыки — доменные `wiki` (база знаний) и `tasks` (менеджер "
    "дел), плюс выученные тобой ранее; их описания ты видишь автоматически и вызываешь "
    "подходящий сам. Процедурная память: когда решил нетривиальную "
    "повторяемую задачу или нашёл рабочий приём — сохрани его навыком через {t[skills.save]} "
    "(name латиницей kebab-case, description = когда применять, body = шаги). В следующий раз "
    "он появится среди навыков и его можно будет вызвать.\n"
    "Файлы: у пользователя есть личное файловое хранилище — обычные папки и файлы в "
    "{files_dir} (отдельно от вики). Работай с ним напрямую: {storage_tools}. Правила: файл "
    "без явного адреса клади в папку "
    "«{files_inbox}»; имена давай человеческие и говорящие (загран-лена-до-2030.jpg, а не "
    "scan_0217.jpg); папки — по сферам жизни (Документы, Авто, Здоровье, Финансы…), не "
    "глубже двух уровней; новые папки создавай по мере надобности. Ничего не удаляй без "
    "явной просьбы — и тогда перемещай в {files_dir}/{files_trash}/, а не стирай. "
    "Отправить файл пользователю в Telegram — {t[tg.send_file]} (путь относительно "
    "хранилища или абсолютный). Упоминая файл хранилища на вики-странице, ВСЕГДА делай "
    "кликабельную ссылку, а не путь текстом: [имя](<storage:Папка/файл.pdf>) — путь "
    "обязательно в угловых скобках, иначе пробелы ломают markdown; картинки инлайн: "
    "![подпись](<storage:Папка/скан.jpg>).\n"
    "Книги: у пользователя есть читалка epub и pdf — библиотека книг, выписки (цветные цитаты, "
    "цвет = смысл) и прогресс чтения. Инструменты: {t[books.list_books]} (какие книги "
    "есть и где человек остановился), {t[books.book_chapters]} (оглавление), "
    "{t[books.read_chapter]} (текст главы), {t[books.search_book]} (поиск по книге), "
    "{t[books.list_highlights]} (выписки). Разговор о книге "
    "веди по самой книге: ищи и читай, а не гадай по присланному фрагменту.\n"
    "Прошлые разговоры: полный журнал всех сессий (веб и Telegram) доступен через "
    "{t[sessions.session_search]}. Если пользователь ссылается на прошлый разговор или "
    "спрашивает то, что могло уже обсуждаться, — сначала поищи в журнале (query='слова'), "
    "не переспрашивай и не выдумывай. Сброс контекста не теряет историю: она вся в журнале.\n"
    "Время: каждое сообщение пользователя начинается служебной строкой [Сейчас: …] с "
    "актуальными датой и временем. Ориентируйся на неё — дата из начала сессии могла устареть "
    "на дни. Саму строку пользователю не показывай и не цитируй.\n"
    "Отвечай кратко и по делу, на языке пользователя. Не выдумывай фактов.\n"
    "Стиль: сначала прямой ответ на вопрос, детали после и только нужные. На бытовой вопрос — "
    "пара предложений, не эссе со списками. Пиши на чистом русском без вкраплений английских "
    "слов посреди фразы. Профессионально и без эмодзи — никаких декоративных символов "
    "(☀️🚀🤝✅🕑 и т.п.) ни в чате, ни в Telegram, ни в навыках."
)

# Чем движок работает с файлами и вебом. У Claude это именованные инструменты, у Codex —
# shell и apply_patch: назвать ему Read и Edit значит послать за несуществующим.
_ENGINE_WORDS = {
    "claude": {
        "file_tools": "Read/Glob/Grep/Write/Edit/Bash",
        "storage_tools": "Read (умеет картинки и PDF), Glob, Bash (mkdir/mv/cp)",
        "web": "WebSearch (поиск) и WebFetch (открыть страницу)",
        "subagents": "Делегирование: для тяжёлых многошаговых задач используй субагентов "
                     "через Task — 'researcher' (глубокий веб-ресёрч) и 'librarian' "
                     "(крупная реорганизация вики).\n",
    },
    "codex": {
        "file_tools": "shell для чтения и поиска, apply_patch для правки",
        "storage_tools": "shell (cat/ls/mkdir/mv/cp) и view_image для картинок и сканов",
        "web": "встроенный веб-поиск",
        "subagents": "",
    },
}


def base_prompt(engine: str = "") -> str:
    engine = engine if engine in ENGINES else ENGINE
    words = _ENGINE_WORDS[engine]
    return _BASE_PROMPT.format(
        t=_Names(engine),
        tasks_prefix=tool_name("tasks", "*", engine),
        wiki_trash=WIKI_TRASH, files_dir=FILES_DIR, files_inbox=FILES_INBOX,
        files_trash=FILES_TRASH,
        **words,
    )

SURFACES = ("wiki", "tasks", "telegram", "books")

# Native SDK Skills plugin (domain skills wiki/tasks). Loaded via the `plugins` option
# in build_options; the model invokes them through the Skill tool.
SKILL_PLUGIN_DIR = os.path.abspath(
    os.environ.get("SKILL_PLUGIN_DIR", os.path.join(os.path.dirname(os.path.dirname(__file__)), "agent_skills"))
)

# Per-surface nudge injected via the UserPromptSubmit hook so the domain frontends bias
# toward their skill. Telegram (universal) is absent on purpose — the model self-selects.
SKILL_NUDGE = {
    "wiki": "Этот разговор открыт из интерфейса Вики. По умолчанию используй навык `wiki`. "
            "Если запрос явно про дела/задачи/планы — вместо этого используй навык `tasks`.",
    "tasks": "Этот разговор открыт из интерфейса Задач. По умолчанию используй навык `tasks`. "
             "Если запрос явно про заметки/знания/вики — вместо этого используй навык `wiki`.",
    "books": "Этот разговор открыт из читалки книг: рядом с вопросом придут книга, глава и "
             "цитата. По умолчанию используй навык `books`. Если просят сохранить выписку "
             "в базу знаний — используй навык `wiki`.",
}

# Agent-authored procedural skills — now native Skills in their own local plugin on the
# data volume (persists across image rebuilds). Layout: <plugin>/skills/<slug>/SKILL.md.
LEARNED_PLUGIN_DIR = os.path.abspath(os.environ.get("LEARNED_PLUGIN_DIR", os.path.join(DATA_DIR, "learned")))
LEARNED_SKILLS_DIR = os.path.join(LEARNED_PLUGIN_DIR, "skills")
LEGACY_SKILLS_DIR = os.path.join(DATA_DIR, "skills")  # old flat layout, migrated once on init
SKILL_BACKUPS_DIR = os.path.join(DATA_DIR, "skill_backups")

# Curator (background consolidation). Idle-triggered.
CURATOR_ENABLED = os.environ.get("CURATOR_ENABLED", "1") not in ("0", "false", "")
CURATOR_INTERVAL_HOURS = float(os.environ.get("CURATOR_INTERVAL_HOURS", "168"))   # weekly
CURATOR_MIN_IDLE_HOURS = float(os.environ.get("CURATOR_MIN_IDLE_HOURS", "2"))     # quiet for 2h
CURATOR_DELIVER = os.environ.get("CURATOR_DELIVER", "telegram")  # telegram | silent


def system_prompt_for(surface: str, engine: str = "") -> str:
    # Domain focus now comes from native Skills + the per-surface nudge hook, not from a
    # surface-specific system prompt. The core is identical for every surface.
    return base_prompt(engine)

# --- Telegram ---
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_ALLOWED_IDS = {
    int(x) for x in os.environ.get("TELEGRAM_ALLOWED_IDS", "").replace(" ", "").split(",")
    if x.lstrip("-").isdigit()
}
# Self-hosted telegram-bot-api server (e.g. http://tgapi:8081) lifts the cloud
# limits (20 MB down / 50 MB up → 2 GB) and hands files over via a shared volume.
TG_API_BASE = os.environ.get("TG_API_BASE", "https://api.telegram.org").rstrip("/")
TG_LOCAL = TG_API_BASE != "https://api.telegram.org"
TG_API = f"{TG_API_BASE}/bot{TELEGRAM_BOT_TOKEN}"
TG_FILE_API = f"{TG_API_BASE}/file/bot{TELEGRAM_BOT_TOKEN}"

# --- ASR (speech-to-text proxy) ---
ASR_UPSTREAM = os.environ.get("ASR_UPSTREAM", "")
ASR_MODEL = os.environ.get("ASR_MODEL", "gigaam-rnnt")
