# Bender

**English** | [Русский](README.ru.md)

A self-hosted personal AI agent: a markdown wiki, a Things-style task manager, and a universal assistant in Telegram — all driven by a single agent. Runs **on a subscription, not on API keys**: either Claude Max via the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview) or ChatGPT Plus/Pro via the [Codex SDK](https://developers.openai.com/codex/sdk). You pick the engine at install time and switch it with one line in `.env`.

![Tasks — Today](docs/screenshots/tasks-today.png)

## Features

- **Tasks** — Things-style mechanics: Inbox / Today / Upcoming / Someday, projects and areas, tags, deadlines, checklists, repeating tasks (weekdays, "second Tuesday", an end after N times or a date — occurrences are laid out ahead, so nothing depends on you ticking the previous one), logbook, drag-and-drop, hotkeys, PWA. Live sync over SSE — changes made from Telegram or by scheduled jobs appear on screen by themselves.
- **Wiki** — a personal knowledge base of markdown files. Confluence-style hierarchy: there are no folders at all, only pages — any page can grow children and becomes a parent (on disk that is a folder with its own `index.md`, but neither "folder" nor "index" ever appears in the UI). Links by name (`[[litellm]]`), so a page can move between parents for free; plain links are rewritten automatically on move. Deleting means trash with undo. Live sync over SSE: edits from the agent, Telegram, or external MCP clients show up on their own.
- **Files** — a personal file storage: plain folders on disk, browsable from the wiki UI (upload, preview, drag-and-drop). Send a document to the Telegram bot — it lands in the inbox folder, gets a human name, and the agent files it into the right folder; ask for a file and the bot sends it back. Wiki pages link to files with `[name](<storage:Folder/file.pdf>)`. Deletes go to a trash folder, not oblivion.
- **Reader** — epub and pdf right in the browser: a shelf with covers and progress, highlights by colour (colour = meaning: important, question, disagree, send to wiki), bookmarks, reading stats and a day streak. The agent sits next to the text and reads the actual book: ask "what is this chapter about" or "translate this paragraph" and it answers from the book, not from the snippet you pasted. Each book keeps its own conversation thread, separate from the main one.
- **Two UI languages** — English and Russian: the wiki follows the browser language, Tasks and the Reader also have a switch in settings. In the Reader the UI language sets the language of the analysis too: an English UI asks the assistant to translate into English, a Russian one into Russian.
- **Assistant everywhere** — web chat in both UIs plus a Telegram bot sharing one session: whatever you discussed on the web, it remembers in Telegram. The reader keeps a thread per book, so working through a chapter doesn't crowd out the main conversation. Voice messages via ASR. Replies stream in Telegram through the native `sendMessageDraft`.
- **Scheduling** — "remind me in 20 minutes", "send my tasks every weekday at 8:30": the agent creates cron jobs itself. Every run sees the outputs of previous runs (no repeating itself), stays quiet when there is nothing new (`[SILENT]`), and stops the job once the tracked event is over (`[FINAL]`).
- **Memory & self-improvement** — long-term memory about the user (survives session resets), self-authored skills, a background reviewer after every turn (decides what to persist), a weekly skill-library curator, and a session freshness window.
- **Subagents** — researcher (web research) and librarian (wiki reorganization) via Task (Claude engine).
- **Two subscriptions to choose from** — Claude Max or ChatGPT Plus/Pro. Wiki, tasks, books, memory, cron, skills and guardrails are identical on both: the tools are described once, and each engine gets them its own way.

| Dark theme & palettes | Project with logbook |
|---|---|
| ![Dark theme](docs/screenshots/tasks-dark.png) | ![Project](docs/screenshots/tasks-project.png) |

![Wiki](docs/screenshots/wiki.png)

| Shelf: covers, progress, highlights | Reading: color highlights and the in-book agent |
|---|---|
| ![Shelf](docs/screenshots/books-shelf.png) | ![Reading](docs/screenshots/books-reading.png) |

## Architecture

```
backend/          FastAPI + the agent engine (single process)
  app/agent.py      sessions, streaming, memory snapshot, freshness window
  app/engines/      claude.py and codex.py: one turn, one shared event stream
  app/tool_registry.py  the single list of domain tools, shared by both engines
  app/mcp_internal.py   the same tools over HTTP — how Codex sees them
  app/scheduler.py  cron ticker (60s), [SILENT]/[FINAL], run history
  app/reviewer.py   background post-turn reviewer (memory/skills)
  app/telegram.py   bot: long polling, draft streaming, /status
  app/tasks_*.py    Things mechanics on SQLite (+SSE)
  app/books_*.py    epub library: parsing, highlights, the whole book for the agent
  agent_skills/     the agent's domain skills (wiki/tasks/books)
frontend-wiki/    React: three panes, markdown, chat
frontend-tasks/   React: tasks, dnd-kit, themes & palettes, chat
frontend-books/   epub reader: shelf, highlights, agent on the book (PWA, no framework)
install.sh        setup wizard: questions, .env, images, verification
bender            day-to-day: doctor / update / rollback / pair / login / token / logs
```

Storage is files and SQLite on a volume: `content/` (markdown wiki), `data/` (tasks, cron, memory, skills, session) and `files/` (personal file storage). None of it is in the repository — that's personal data.

## Quick start

You need Docker. That is the whole list.

```bash
git clone https://github.com/0717376/bender && cd bender
./install.sh
```

The installer asks which subscription to run on (Claude Max or ChatGPT), then a handful of
questions (web password, model, timezone, Telegram bot — optional), sorts out the
credentials, pulls the images, brings the stand up and then checks it for real: backend
answering, agent actually authenticated, bot reachable. Codex signs in by device code —
any browser will do, just not one on this machine, so a bare VM over ssh works fine.
At the end it prints the addresses:

- Tasks: http://localhost:8851
- Wiki: http://localhost:8842
- Books: http://localhost:8899 (you fill the shelf yourself — books live in `books/`, never in the repo)

Telegram binds by a six-digit code the installer prints: send it to your bot and the chat
is paired — no config editing, no restart.

Afterwards:

```bash
./bender doctor   # containers, auth, bot, ports, disk — one line per check
./bender update   # git pull, fresh images, restart, health check
./bender login    # sign in to ChatGPT by device code (codex engine)
```

Authentication on a headless server, self-hosted bot-api for 2 GB files, every environment
variable, installing by hand: [docs/configuration.md](docs/configuration.md).

## License

MIT
