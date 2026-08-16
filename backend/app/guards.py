"""Запреты, которые нельзя доверить промпту.

У шелла рабочая директория — корень вики, так что `rm` стирает страницы мимо корзины
и мимо всякой отмены. Просьбы в промпте тут мало: запрещаем жёстко, оставляя временные
файлы вне вики и хранилища. Правило одно на оба движка: у Claude его применяет хук
Agent SDK, у Codex — скрипт codex_hook.py, и разъезжаться им нельзя.
"""

import os
import re
import shlex

from . import config

TEMP_DIRS = ("/tmp/", "/var/tmp/", "/var/folders/")
# Слова, за которыми команда продолжается: `sudo rm`, `find … -exec rm`.
RUNNERS = ("sudo", "env", "time", "nohup", "xargs")
# Оболочки, которые прячут настоящую команду в своём аргументе: `bash -lc "rm -rf x"`.
SHELLS = ("sh", "bash", "zsh", "dash", "ash")


def _unwrap(cmd: str, depth: int = 0) -> str:
    """Развернуть `bash -lc "…"` до самой команды: иначе запрет обходится одной обёрткой.
    Codex и вовсе присылает шелл списком аргументов — там это единственный вид команды."""
    if depth > 3:
        return cmd
    try:
        tokens = shlex.split(cmd)
    except ValueError:
        return cmd
    head = 0
    while head < len(tokens) and tokens[head] in RUNNERS:
        head += 1
    if head >= len(tokens) or os.path.basename(tokens[head]) not in SHELLS:
        return cmd
    for i in range(head + 1, len(tokens)):
        if tokens[i].startswith("-") and "c" in tokens[i]:
            rest = tokens[i + 1:]
            if not rest:
                return cmd
            return _unwrap(rest[0] if len(rest) == 1 else " ".join(rest), depth + 1)
    return cmd

RM_DENIED = (
    "rm запрещён: удаление должно быть отменяемым. Перемести в корзину — "
    f"страницу вики в {config.WIKI_TRASH}/ (рядом с корнем вики), файл "
    f"хранилища в {config.FILES_DIR}/{config.FILES_TRASH}/."
)


def rm_args(cmd: str) -> list[str] | None:
    """Что именно стирает команда. None — rm в ней нет (например, это аргумент grep)."""
    args: list[str] = []
    found = False
    for segment in re.split(r"[;&|\n]+", _unwrap(cmd or "")):
        try:
            tokens = shlex.split(segment)
        except ValueError:
            tokens = segment.split()
        starts = []
        head = 0
        while head < len(tokens) and tokens[head] in RUNNERS:
            head += 1
        if head < len(tokens) and tokens[head] == "rm":
            starts.append(head)
        starts += [i + 1 for i, tok in enumerate(tokens[:-1])
                   if tok in ("-exec", "-execdir") and tokens[i + 1] == "rm"]
        for start in starts:
            found = True
            args += [t for t in tokens[start + 1:]
                     if not t.startswith("-") and t not in ("{}", "+", ";")]
    return args if found else None


def rm_allowed(cmd: str) -> bool:
    """Разрешена ли команда: rm'а нет вовсе или он чистит только временные каталоги."""
    args = rm_args(cmd)
    return args is None or bool(args) and all(a.startswith(TEMP_DIRS) for a in args)
