#!/usr/bin/env bash
# Установка Bender: спрашивает нужное, пишет .env, поднимает стенд и проверяет, что он живой.
# Повторный запуск безопасен: существующие ответы подставляются по умолчанию.
set -euo pipefail
cd "$(dirname "$0")"

source ./scripts/common.sh

YES=0; MODE=""
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --source) MODE=local ;;
    --prebuilt) MODE=prebuilt ;;
    --help|-h) cat <<'USAGE'
Использование: ./install.sh [--yes] [--source|--prebuilt]

  --yes       без вопросов: берёт ответы из существующего .env и переменных окружения
  --source    собирать образы из исходников (нужно, если правите код)
  --prebuilt  брать готовые образы из GHCR (быстрее: скачивание вместо сборки)
USAGE
      exit 0 ;;
    *) die "неизвестный ключ: $arg (см. --help)" ;;
  esac
done
[ -t 0 ] || YES=1

title "Установка Bender"

# --- Шаг 1. Чем поднимать -----------------------------------------------------
have docker || die "нет docker. Поставьте Docker: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "нет плагина docker compose (нужен Docker 20.10+)"
docker info >/dev/null 2>&1 || die "демон Docker не отвечает — запустите Docker и повторите"
ok "docker и compose на месте"

# --- Шаг 2. Каталоги данных ---------------------------------------------------
# Заводим сами и от текущего пользователя: иначе их создаст Docker от root,
# и на линуксовом хосте свою же вики не отредактируешь без sudo.
mkdir -p content data files books tg-bot-api
# Пустого ~/.claude.json Docker не найдёт и подставит на его место КАТАЛОГ,
# после чего CLI молча ломается. Заводим файлом заранее.
mkdir -p "$HOME/.claude"
[ -e "$HOME/.claude.json" ] || echo '{}' > "$HOME/.claude.json"
ok "каталоги данных готовы"

# --- Шаг 3. Ответы ------------------------------------------------------------
env_load .env

say
say "Агент работает по подписке — либо Claude (Max), либо ChatGPT (Codex)."
say "  1) Claude — подписка Anthropic Max"
say "  2) Codex  — подписка OpenAI ChatGPT (Plus/Pro)"
if [ "$YES" = 1 ]; then
  ENGINE=${ENGINE:-claude}
else
  case "$(ask "Выбор" "$([ "${ENGINE:-claude}" = codex ] && echo 2 || echo 1)")" in
    2|codex|Codex) ENGINE=codex ;;
    *) ENGINE=claude ;;
  esac
fi

WIKI_PASSWORD=$(ask_secret "Пароль для веб-интерфейсов" "${WIKI_PASSWORD:-$(rand_pass)}")
if [ "$ENGINE" = codex ]; then
  # Пустая строка — модель по умолчанию: список моделей у OpenAI меняется чаще,
  # чем выходят наши релизы, и подсказывать устаревшее имя вреднее, чем молчать.
  CODEX_MODEL=$(ask "Модель агента (пусто — та, что Codex выберет сам)" "${CODEX_MODEL:-}")
else
  CLAUDE_MODEL=$(ask "Модель агента (sonnet/opus/haiku или полный id)" "${CLAUDE_MODEL:-sonnet}")
fi
TZ=$(ask "Таймзона (по ней срабатывают напоминания)" "${TZ:-$(host_tz)}")

WIKI_PORT=$(ask_port "Порт вики" "${WIKI_PORT:-8842}")
TASKS_PORT=$(ask_port "Порт задач" "${TASKS_PORT:-8851}")
BOOKS_PORT=$(ask_port "Порт читалки" "${BOOKS_PORT:-8899}")

say
say "Telegram-бот — необязателен, но с ним ассистент всегда под рукой."
say "Токен берётся у @BotFather за минуту; пустая строка — пропустить."
TELEGRAM_BOT_TOKEN=$(ask "Токен бота" "${TELEGRAM_BOT_TOKEN:-}")

# --- Шаг 4. Авторизация -------------------------------------------------------
# Агент ходит по подписке, а не по API-ключу. У Codex вход по коду устройства — его
# делаем после подъёма стенда (нужен работающий контейнер). У Claude на сервере без
# браузера живёт только долгоживущий токен: OAuth-сессия в ~/.claude однажды перестаёт
# обновляться, и агент начинает отвечать «Failed to authenticate».
say
if [ "$ENGINE" = codex ]; then
  AUTH=codex
  say "Вход в ChatGPT сделаем сразу после запуска — браузер понадобится любой, но не здешний."
elif [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  ok "токен Claude уже есть в .env — оставляю"
  AUTH=token
elif [ "$YES" = 1 ]; then
  AUTH=session
  warn "токена Claude нет — беру сессию из ~/.claude (на сервере она однажды протухнет: ./bender token)"
else
  say "Как агенту авторизоваться в Claude:"
  say "  1) выпустить долгоживущий токен (год) — годится и для сервера без браузера"
  say "  2) взять OAuth-сессию из ~/.claude — годится для своей машины"
  case "$(ask "Выбор" "1")" in
    2) AUTH=session ;;
    *) AUTH=token ;;
  esac
fi

if [ "$AUTH" = token ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && have claude; then
  say
  say "Сейчас откроется вход в Claude. Скопируйте выданный токен и вставьте ниже."
  claude setup-token || warn "не получилось — токен можно выпустить позже: ./bender token"
  CLAUDE_CODE_OAUTH_TOKEN=$(ask_secret "Токен (sk-ant-oat…), пусто — пропустить" "")
fi

# --- Шаг 5. .env --------------------------------------------------------------
if [ -z "$MODE" ]; then
  if [ "$YES" = 1 ]; then
    MODE=$([ "${BENDER_TAG:-local}" = local ] && echo local || echo prebuilt)
  else
    say
    say "Откуда брать образы:"
    say "  1) готовые из GHCR — минута вместо сборки"
    say "  2) собрать из исходников — если собираетесь править код"
    case "$(ask "Выбор" "1")" in
      2) MODE=local ;;
      *) MODE=prebuilt ;;
    esac
  fi
fi
BENDER_TAG=$([ "$MODE" = local ] && echo local || echo main)

env_save .env $ENV_KEYS
ok ".env записан (права 600)"

# --- Шаг 6. Подъём ------------------------------------------------------------
say
if [ "$BENDER_TAG" = local ]; then
  say "Собираю образы — первый раз это несколько минут."
  dc up -d --build
else
  say "Скачиваю образы."
  dc pull --quiet || die "не скачались образы. Повторите с ./install.sh --source (сборка из исходников)"
  dc up -d --no-build
fi

if [ "$AUTH" = token ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && ! have claude; then
  say
  say "Выпускаю токен Claude внутри контейнера — следуйте инструкции на экране."
  dc run --rm backend claude setup-token || warn "не получилось: повторите позже через ./bender token"
  CLAUDE_CODE_OAUTH_TOKEN=$(ask_secret "Токен (sk-ant-oat…), пусто — пропустить" "")
  if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    env_save .env $ENV_KEYS
    dc up -d backend
  fi
fi

wait_healthy 120 || die "бэкенд не поднялся. Логи: ./bender logs backend"
ok "бэкенд отвечает"

# --- Шаг 7. Проверки ----------------------------------------------------------
if [ "$AUTH" = codex ] && [ "$YES" != 1 ]; then
  say
  title "Вход в ChatGPT"
  say "Откройте показанный адрес на телефоне или ноутбуке и введите код."
  dc exec backend "$BACKEND_PY" -m app.codex_cli login || \
    warn "войти не удалось — повторите позже: ./bender login"
fi

say
say "Проверяю авторизацию агента — это занимает несколько секунд."
if check_auth; then
  ok "агент авторизован"
else
  warn "агент не авторизовался. Дальше: $(auth_hint)"
fi

if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  code=$(pair_code 30 || true)
  say
  if [ -n "$code" ]; then
    title "Код привязки Telegram: $code"
    say "Откройте своего бота и отправьте ему этот код — чат привяжется без правки конфига."
  else
    ok "Telegram уже привязан"
  fi
fi

# --- Готово -------------------------------------------------------------------
host=$(host_addr)
say
title "Готово"
say "  Задачи:  http://$host:$TASKS_PORT"
say "  Вики:    http://$host:$WIKI_PORT"
say "  Книги:   http://$host:$BOOKS_PORT"
say "  Пароль:  $WIKI_PASSWORD"
say "  Движок:  $ENGINE"
say
say "Дальше: ./bender doctor — проверка стенда, ./bender update — обновление."
