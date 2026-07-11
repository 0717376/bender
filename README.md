# Bender

[English](README.en.md) | **Русский**

Личный ИИ-агент на своём железе: вики-заметки, менеджер задач в духе Things и универсальный ассистент в Telegram — всё поверх одного агента на [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview). Работает на подписке Claude (OAuth через Claude CLI), без API-ключей.

![Задачи — Сегодня](docs/screenshots/tasks-today.png)

## Что умеет

- **Задачи** — механика Things: Входящие / Сегодня / Предстоящие / Когда-нибудь, проекты и области, теги, дедлайны, чек-листы, повторяющиеся задачи, журнал, drag-and-drop, горячие клавиши, PWA. Живая синхронизация через SSE — правки из Telegram или по расписанию появляются на экране сами.
- **Вики** — личная база знаний в markdown-файлах. Агент читает и пишет страницы, ставит ссылки, наводит порядок.
- **Ассистент везде** — веб-чат в обоих интерфейсах и Telegram-бот с общей сессией: что обсудили в чате, он помнит и в телеге. Голосовые — через ASR. Стриминг ответов в Telegram через нативный `sendMessageDraft`.
- **Расписание** — «напомни через 20 минут», «каждый будний день в 8:30 пришли задачи»: агент сам заводит cron-задания. Каждый запуск видит выводы предыдущих (не повторяется), молчит, когда нечего сказать (`[SILENT]`), и останавливает задание после финала события (`[FINAL]`).
- **Память и самообучение** — долговременная память о пользователе (переживает сброс сессии), самописные навыки-скиллы, фоновый ревьюер после каждого хода (решает, что сохранить), еженедельный «куратор» библиотеки навыков, окно свежести сессии.
- **Субагенты** — researcher (веб-ресёрч) и librarian (реорганизация вики) через Task.

| Тёмная тема и палитры | Проект с журналом |
|---|---|
| ![Тёмная тема](docs/screenshots/tasks-dark.png) | ![Проект](docs/screenshots/tasks-project.png) |

![Вики](docs/screenshots/wiki.png)

## Архитектура

```
backend/          FastAPI + claude-agent-sdk (один процесс)
  app/agent.py      сессии, стриминг, снапшот памяти, окно свежести
  app/scheduler.py  cron-тикер (60с), [SILENT]/[FINAL], история запусков
  app/reviewer.py   фоновый пост-ходовой ревьюер (память/навыки)
  app/telegram.py   бот: long polling, стриминг-черновики, /status
  app/tasks_*.py    Things-механика поверх SQLite (+SSE)
  agent_skills/     доменные навыки агента (wiki/tasks)
frontend-wiki/    React: три панели, markdown, чат
frontend-tasks/   React: задачи, dnd-kit, темы и палитры, чат
```

Хранилище — файлы и SQLite на volume: `content/` (markdown-вики) и `data/` (задачи, cron, память, навыки, сессия). Ни того ни другого в репозитории нет — это личные данные.

## Быстрый старт

Понадобится Docker и авторизованный [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (агент работает через его OAuth-креды из `~/.claude`).

```bash
git clone https://github.com/0717376/bender && cd bender

cat > .env <<'ENV'
WIKI_PASSWORD=придумайте-пароль
CLAUDE_MODEL=sonnet
# Telegram (необязательно): токен бота и ваш chat id
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_IDS=
ENV

docker compose up -d --build
```

- Задачи: http://localhost:8851
- Вики: http://localhost:8842

Первое сообщение боту в Telegram подскажет ваш ID — впишите его в `TELEGRAM_ALLOWED_IDS` и перезапустите backend.

### Переменные окружения

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `WIKI_PASSWORD` | — | пароль веб-интерфейсов (обязателен) |
| `CLAUDE_MODEL` | `sonnet` | модель агента (`sonnet`/`opus`/`haiku`) |
| `TELEGRAM_BOT_TOKEN` | — | токен бота; пусто — бот выключен |
| `TELEGRAM_ALLOWED_IDS` | — | список chat id через запятую |
| `ASR_UPSTREAM` | — | URL сервиса распознавания речи для голосовых |
| `SESSION_FRESH_HOURS` | `6` | простой, после которого сессия начинается заново |
| `REVIEWER_ENABLED` / `REVIEWER_MODEL` | `1` / `sonnet` | фоновый ревьюер памяти и навыков |
| `CURATOR_ENABLED` / `CURATOR_INTERVAL_HOURS` | `1` / `168` | куратор библиотеки навыков |
| `CLAUDE_DIR` / `CLAUDE_JSON` | `~/.claude` / `~/.claude.json` | креды Claude CLI, монтируются в контейнер |
| `WIKI_PORT` / `TASKS_PORT` | `8842` / `8851` | порты фронтендов |
| `TZ` | `Europe/Moscow` | часовой пояс (важен для cron) |

## Лицензия

MIT
