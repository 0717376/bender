# Configuration & operation

[Русская версия](configuration.ru.md)

Everything here is optional reading: `./install.sh` asks the questions that matter and
writes `.env` for you. This page is for the settings the wizard does not ask about, and
for running the thing afterwards.

## The `bender` command

```
./bender doctor            check the stand: containers, auth, bot, ports, disk
./bender update            git pull, fresh images, restart, health check
./bender update --check    only look whether something new has landed
./bender rollback          go back to the version that ran before the last update
./bender pair [--reset]    Telegram pairing code
./bender login             sign in to ChatGPT by device code (codex engine)
./bender token             issue a new long-lived Claude token and store it in .env
./bender logs [service]    follow logs
./bender up | down | restart | version
```

`update` and `up` always restart the frontends. Their nginx resolves the backend's
container IP once, at startup, and caches it: recreate the backend without restarting
them and every page answers 502.

## Engine: Claude or Codex

`ENGINE=claude` runs on an Anthropic Max subscription, `ENGINE=codex` on an OpenAI
ChatGPT one (Plus/Pro). Both SDKs ship inside the image, so switching is a line in `.env`
plus `./bender restart` — nothing to rebuild. The data is shared: wiki, tasks, books,
memory, skills and the session journal don't care which engine wrote them.

What is identical on both: the set of domain tools (tasks, cron, memory, skills, books,
session journal, sending files to Telegram), the ban on deleting past the trash, the
read-only book library, domain and learned skills, the persona, the session freshness
window, the background reviewer and the curator.

How they differ:

| | Claude | Codex |
|---|---|---|
| subscription | Max | ChatGPT Plus/Pro |
| sign-in | long-lived token (`./bender token`) | device code (`./bender login`) |
| agent tools | in-process MCP servers | the same ones, over HTTP inside the container |
| editing files | Read/Write/Edit/Bash | shell and apply_patch |
| guardrails | Agent SDK hooks | a hook in `/etc/codex/managed_config.toml` |
| web | WebSearch + WebFetch | built-in web search |
| subagents | researcher and librarian via Task | none (in this first version) |
| conversation thread | Claude Code session | Codex thread |

Worth knowing up front: Codex is a coding harness — drier in tone, keener to reach for
the shell — and ChatGPT subscription limits are metered differently from Max, which shows
with cron, the reviewer and the curator all running.

### About the sandbox and the guardrails

Codex's own sandbox does not work inside Docker: bubblewrap needs user namespaces and
Docker denies them by default, so every shell command fails in that mode. The engine
therefore runs without it — the container is the boundary, exactly as on the Claude
engine — and the wiki and the book library are guarded by `app/codex_hook.py`, which
denies `rm` past the trash, deletion by patch, and writes into the library.

The hook lives in `/etc/codex/managed_config.toml`, the admin-level config, which Codex
runs straight away. The same hook in the user config (`$CODEX_HOME/hooks.json`) is
silently ignored until a human reviews and trusts it in the UI, and there is no human in
a container. The backend writes the file at startup; `./bender doctor` checks the hook's
actual decisions rather than the file's existence, on its own line.

One more quirk: before every MCP tool call Codex asks for permission, and the SDK answers
that question with silence — which counts as a refusal. We answer it ourselves, but only
for our own tool server; anyone else's is declined.

## Authentication

### Codex (ChatGPT subscription)

```bash
./bender login
```

It prints a URL and a six-character code: open the URL on your phone or laptop, type the
code, done. No browser needed on the machine itself, so this works on a bare server over
ssh. The token lands in `data/codex/` — a volume, so the sign-in survives updates and
container rebuilds. Note it for backups: `data/` now holds credentials too.

If device-code sign-in is disabled in your ChatGPT security settings (personal account)
or by a workspace admin, enable it there — otherwise signing in on a headless machine
is impossible.

### Claude (Max subscription)

The agent talks to Claude on your subscription, through the Claude CLI, and there are
two ways to give it credentials:

- **A long-lived token** — `claude setup-token` issues one valid for a year; it goes into
  `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. This is the only sane option on a server: browser
  not required, and it survives reboots.
- **The OAuth session in `~/.claude`** — mounted into the container. Fine on your own
  machine. On a headless host it eventually stops refreshing and the agent starts
  answering "Failed to authenticate"; `./bender doctor` catches that.

`./bender token` re-issues and rewires the token without touching anything else.

## Telegram

Create a bot with [@BotFather](https://t.me/BotFather), put the token into `.env`, and
run `./bender pair` — it prints a six-digit code. Send that code to your bot and the chat
is bound: the id is stored in `data/telegram.json`, no config edit, no restart. The code
is one-shot and stops working the moment a chat is paired.

Setting `TELEGRAM_ALLOWED_IDS` explicitly overrides pairing entirely — an already
configured server does not need a spare door.

### Large files (optional)

The cloud Bot API caps files at 20 MB down / 50 MB up. The bundled `tgapi` service
(official self-hosted [telegram-bot-api](https://github.com/tdlib/telegram-bot-api))
lifts both limits to 2 GB:

1. Get an `api_id` / `api_hash` at [my.telegram.org](https://my.telegram.org) → API
   development tools (any app name; these identify an "application", they do not grant
   access to your account).
2. Add to `.env`:
   ```
   TELEGRAM_API_ID=...
   TELEGRAM_API_HASH=...
   TG_API_BASE=http://tgapi:8081
   ```
3. Log the bot out of the cloud (one-off, reversible): `curl https://api.telegram.org/bot<TOKEN>/logOut`
4. `docker compose up -d tgapi backend`

The backend detects the local server via `TG_API_BASE` and reads incoming files straight
from the shared `tg-bot-api/` volume instead of re-downloading them over HTTP. Leave the
variables unset and everything keeps working through the cloud API.

## Images: prebuilt or from source

`BENDER_TAG` decides. `main` pulls ready-made multi-arch images (amd64/arm64) from GHCR —
installation becomes a download instead of a build. `local` builds from the working tree,
which is what you want if you intend to edit the code. `./install.sh --source` and
`./install.sh --prebuilt` set it; `./bender update` follows whatever is in `.env`.

The images are built by the `images` workflow on every push to `main`. If you forked the
project, make the GHCR packages public once after the first build (package page → Package
settings → Change visibility), otherwise `docker compose pull` asks for a login.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `WIKI_PASSWORD` | — | web UI password (required) |
| `ENGINE` | `claude` | `claude` (Max subscription) or `codex` (ChatGPT subscription) |
| `CODEX_MODEL` | — | model for the codex engine; empty — whatever Codex picks itself |
| `CODEX_HOME` | `data/codex` | Codex state: sign-in, threads, caches |
| `CLAUDE_MODEL` | `sonnet` | agent model (`sonnet`/`opus`/`haiku` or a full id) |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | long-lived token from `claude setup-token`; when set, used instead of the OAuth session in `~/.claude` |
| `CLAUDE_DIR` / `CLAUDE_JSON` | `~/.claude` / `~/.claude.json` | Claude CLI credentials mounted into the container |
| `TELEGRAM_BOT_TOKEN` | — | bot token; empty disables the bot |
| `TELEGRAM_ALLOWED_IDS` | — | comma-separated chat ids; empty means pairing by code |
| `TG_API_BASE` | `https://api.telegram.org` | local bot-api server URL (see above) |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | — | my.telegram.org keys for the `tgapi` service |
| `FILES_MAX_UPLOAD` | `524288000` | web upload size limit, bytes |
| `ASR_UPSTREAM` | — | speech-to-text service URL for voice messages |
| `ASR_MODEL` | `gigaam-rnnt` | model_id passed to the ASR service |
| `SESSION_FRESH_HOURS` | `6` | idle time after which a fresh session starts |
| `REVIEWER_ENABLED` / `REVIEWER_MODEL` | `1` / `sonnet` | background memory/skills reviewer |
| `CURATOR_ENABLED` / `CURATOR_INTERVAL_HOURS` | `1` / `168` | skill-library curator |
| `WIKI_PORT` / `TASKS_PORT` / `BOOKS_PORT` | `8842` / `8851` / `8899` | frontend ports |
| `BENDER_TAG` | `local` | `main` — prebuilt images from GHCR, `local` — build from source |
| `TZ` | `Europe/Moscow` | timezone (matters for cron) |

## Manual install

```bash
git clone https://github.com/0717376/bender && cd bender
cp .env.example .env && $EDITOR .env
mkdir -p content data files books tg-bot-api
docker compose up -d --build
```

Two things the wizard does that are easy to forget by hand: create the data directories
before Docker creates them as root, and make sure `~/.claude.json` exists as a *file* —
if it is missing, Docker mounts a directory in its place and the CLI breaks silently.

## When something is wrong

Start with `./bender doctor`; it names the broken part. Then:

- **502 on every page** — the frontends are holding a stale backend IP: `./bender restart`.
- **"Failed to authenticate" in chat** — the token expired: `./bender token`.
- **The bot is silent** — check `doctor`: it pings `getMe` and tells you whether a chat is
  paired at all.
- **Nothing at all** — `./bender logs backend`.

Your data (`content/`, `data/`, `files/`, `books/`) lives on disk next to the repository
and no update or rollback touches it.
