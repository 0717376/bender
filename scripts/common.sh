# Общие функции установщика и ./bender. Подключается через `source ./scripts/common.sh`.
# Совместимо с bash 3.2 (штатный bash в macOS): без ассоциативных массивов и mapfile.

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_B=""; C_0=""
fi

say()  { printf '%s\n' "${1-}"; }
title() { printf '\n%s%s%s\n\n' "$C_B" "$1" "$C_0"; }
ok()   { printf '%s  ok %s %s\n' "$C_OK" "$C_0" "$1"; }
warn() { printf '%s  !  %s %s\n' "$C_WARN" "$C_0" "$1"; }
bad()  { printf '%s нет %s %s\n' "$C_ERR" "$C_0" "$1"; }
dim()  { printf '%s      %s%s\n' "$C_DIM" "$1" "$C_0"; }
die()  { printf '\n%sОшибка:%s %s\n' "$C_ERR" "$C_0" "$1" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Вопрос с ответом по умолчанию. Промпт уходит в терминал, ответ — в stdout,
# иначе подстановка $(ask ...) съела бы сам вопрос.
_prompt() { if [ -e /dev/tty ]; then printf '%s' "$1" > /dev/tty; else printf '%s' "$1" >&2; fi; }

ask() {
  local q="$1" def="${2-}" a=""
  if [ "${YES:-0}" = 1 ]; then printf '%s' "$def"; return; fi
  if [ -n "$def" ]; then _prompt "$q [$def]: "; else _prompt "$q: "; fi
  if [ -e /dev/tty ]; then read -r a < /dev/tty; else read -r a; fi
  printf '%s' "${a:-$def}"
}

# То же, но ввод не эхоится: пароли и токены не должны оставаться на экране
# и в скроллбеке. Пустой ввод — значение по умолчанию.
ask_secret() {
  local q="$1" def="${2-}" a=""
  if [ "${YES:-0}" = 1 ] || [ ! -e /dev/tty ]; then printf '%s' "$def"; return; fi
  if [ -n "$def" ]; then _prompt "$q [оставить прежний]: "; else _prompt "$q: "; fi
  read -rs a < /dev/tty; printf '\n' > /dev/tty
  printf '%s' "${a:-$def}"
}

port_busy() { (exec 3<>/dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1; }

ask_port() {
  local v; v=$(ask "$1" "$2")
  if port_busy "$v"; then warn "порт $v уже занят — если это не сам Bender, поменяйте его в .env" >&2; fi
  printf '%s' "$v"
}

rand_pass() {
  if have openssl; then openssl rand -base64 18 | tr -d '/+=' | cut -c1-14
  else head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-14; fi
}

host_tz() {
  local tz=""
  if [ -L /etc/localtime ]; then tz=$(readlink /etc/localtime); tz=${tz##*zoneinfo/}; fi
  [ -z "$tz" ] && [ -f /etc/timezone ] && tz=$(cat /etc/timezone)
  printf '%s' "${tz:-${TZ:-Europe/Moscow}}"
}

# Адрес, по которому интерфейсы откроются у того, кто ставит: на сервере по ssh
# «localhost» бесполезен, там нужен адрес самого сервера.
host_addr() {
  if [ -n "${SSH_CONNECTION:-}" ]; then printf '%s' "$(echo "$SSH_CONNECTION" | awk '{print $3}')"
  else printf 'localhost'; fi
}

# Читает KEY=VALUE из .env в одноимённые переменные. Не исполняет файл: там
# лежат пароли и токены, лишний eval в этом месте не нужен.
env_load() {
  [ -f "$1" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key=${line%%=*}; val=${line#*=}
    case "$key" in *[!A-Za-z0-9_]*) continue ;; esac
    val=${val%\"}; val=${val#\"}
    printf -v "$key" '%s' "$val"
  done < "$1"
}

# Перезаписывает .env перечисленными ключами, сохраняя всё остальное, что человек
# добавил руками (ASR_UPSTREAM, TG_API_BASE и прочее).
env_save() {
  local file="$1"; shift
  local tmp="$file.tmp" key val line
  : > "$tmp"; chmod 600 "$tmp"
  for key in "$@"; do
    eval "val=\${$key-}"
    case "$val" in *[\ \"\']*) val="\"$(printf '%s' "$val" | sed 's/"/\\"/g')\"" ;; esac
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
  done
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      # Комментарии человека сохраняем: он их писал не для того, чтобы установщик их стёр.
      case "$line" in '') continue ;; '#'*) printf '%s\n' "$line" >> "$tmp"; continue ;;
                       *=*) key=${line%%=*} ;; *) continue ;; esac
      for k in "$@"; do [ "$k" = "$key" ] && continue 2; done
      printf '%s\n' "$line" >> "$tmp"
    done < "$file"
  fi
  mv "$tmp" "$file"
}

dc() { docker compose "$@"; }

# Ограничение по времени: `timeout` есть не везде (в macOS его нет вовсе).
run_timeout() {
  local secs="$1"; shift
  "$@" & local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null ) & local watcher=$!
  disown "$watcher" 2>/dev/null || true   # иначе оболочка печатает «Terminated» поверх вывода
  local rc=0; wait "$pid" 2>/dev/null || rc=$?
  kill -TERM "$watcher" 2>/dev/null || true
  return $rc
}

backend_health() { dc exec -T backend curl -fsS -m 5 localhost:8000/health >/dev/null 2>&1; }

wait_healthy() {
  local secs="${1:-120}" i=0
  while [ "$i" -lt "$secs" ]; do
    backend_health && return 0
    i=$((i + 3)); sleep 3
  done
  return 1
}

# Настоящая проверка авторизации: один короткий ход через тот же CLI, которым
# ходит агент. Наличие токена в .env ничего не доказывает — он мог протухнуть.
check_auth() {
  run_timeout 120 dc exec -T backend claude -p 'Ответь одним словом: ok' >/dev/null 2>&1
}

# Код привязки Telegram кладёт бэкенд при старте; ждём его появления.
pair_code() {
  local secs="${1:-1}" i=0 out=""
  while [ "$i" -lt "$secs" ]; do
    out=$(dc exec -T backend cat /app/data/telegram.json 2>/dev/null | \
          sed -n 's/.*"code"[^"]*"\([0-9]\{6\}\)".*/\1/p' | head -1) || true
    [ -n "$out" ] && { printf '%s' "$out"; return 0; }
    i=$((i + 2)); sleep 2
  done
  return 1
}

# Фронтенды кэшируют IP бэкенда при старте своего nginx: пересобрали бэкенд —
# без этого рестарта они отдают 502 на всё живое.
restart_frontends() { dc restart frontend-wiki frontend-tasks frontend-books >/dev/null; }
