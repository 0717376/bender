# Bender

**English** | [Русский](README.ru.md)

A self-hosted personal AI agent: a markdown wiki, a Things-style task manager, and a universal assistant in Telegram — all driven by a single agent built on the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview). Runs on your Claude subscription (OAuth via Claude CLI), no API keys required.

![Tasks — Today](docs/screenshots/tasks-today.png)

## Features

- **Tasks** — Things-style mechanics: Inbox / Today / Upcoming / Someday, projects and areas, tags, deadlines, checklists, repeating tasks, logbook, drag-and-drop, hotkeys, PWA. Live sync over SSE — changes made from Telegram or by scheduled jobs appear on screen by themselves.
- **Wiki** — a personal knowledge base of markdown files. The agent reads and writes pages, cross-links them, and keeps things tidy.
- **Two UI languages** — English and Russian: switchable in Tasks settings; the wiki follows the browser language.
- **Assistant everywhere** — web chat in both UIs plus a Telegram bot sharing one session: whatever you discussed on the web, it remembers in Telegram. Voice messages via ASR. Replies stream in Telegram through the native `sendMessageDraft`.
- **Scheduling** — "remind me in 20 minutes", "send my tasks every weekday at 8:30": the agent creates cron jobs itself. Every run sees the outputs of previous runs (no repeating itself), stays quiet when there is nothing new (`[SILENT]`), and stops the job once the tracked event is over (`[FINAL]`).
- **Memory & self-improvement** — long-term memory about the user (survives session resets), self-authored skills, a background reviewer after every turn (decides what to persist), a weekly skill-library curator, and a session freshness window.
- **Subagents** — researcher (web research) and librarian (wiki reorganization) via Task.

| Dark theme & palettes | Project with logbook |
|---|---|
| ![Dark theme](docs/screenshots/tasks-dark.png) | ![Project](docs/screenshots/tasks-project.png) |

![Wiki](docs/screenshots/wiki.png)

## Architecture

```
backend/          FastAPI + claude-agent-sdk (single process)
  app/agent.py      sessions, streaming, memory snapshot, freshness window
  app/scheduler.py  cron ticker (60s), [SILENT]/[FINAL], run history
  app/reviewer.py   background post-turn reviewer (memory/skills)
  app/telegram.py   bot: long polling, draft streaming, /status
  app/tasks_*.py    Things mechanics on SQLite (+SSE)
  agent_skills/     the agent's domain skills (wiki/tasks)
frontend-wiki/    React: three panes, markdown, chat
frontend-tasks/   React: tasks, dnd-kit, themes & palettes, chat
```

Storage is files and SQLite on a volume: `content/` (markdown wiki) and `data/` (tasks, cron, memory, skills, session). Neither is in the repository — that's personal data.

## Quick start

You need Docker and an authenticated [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (the agent uses its OAuth credentials from `~/.claude`).

```bash
git clone https://github.com/0717376/bender && cd bender

cat > .env <<'ENV'
WIKI_PASSWORD=pick-a-password
CLAUDE_MODEL=sonnet
# Telegram (optional): bot token and your chat id
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_IDS=
ENV

docker compose up -d --build
```

- Tasks: http://localhost:8851
- Wiki: http://localhost:8842

The first message to the Telegram bot will tell you your ID — put it into `TELEGRAM_ALLOWED_IDS` and restart the backend.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `WIKI_PASSWORD` | — | web UI password (required) |
| `CLAUDE_MODEL` | `sonnet` | agent model (`sonnet`/`opus`/`haiku`) |
| `TELEGRAM_BOT_TOKEN` | — | bot token; empty disables the bot |
| `TELEGRAM_ALLOWED_IDS` | — | comma-separated chat ids |
| `ASR_UPSTREAM` | — | speech-to-text service URL for voice messages |
| `ASR_MODEL` | `gigaam-rnnt` | model_id passed to the ASR service |
| `SESSION_FRESH_HOURS` | `6` | idle time after which a fresh session starts |
| `REVIEWER_ENABLED` / `REVIEWER_MODEL` | `1` / `sonnet` | background memory/skills reviewer |
| `CURATOR_ENABLED` / `CURATOR_INTERVAL_HOURS` | `1` / `168` | skill-library curator |
| `CLAUDE_DIR` / `CLAUDE_JSON` | `~/.claude` / `~/.claude.json` | Claude CLI credentials mounted into the container |
| `WIKI_PORT` / `TASKS_PORT` | `8842` / `8851` | frontend ports |
| `TZ` | `Europe/Moscow` | timezone (matters for cron) |

## License

MIT
