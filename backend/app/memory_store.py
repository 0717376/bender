"""Long-term memory: persists across sessions, injected into every turn.

Survives /clear and /compact (it is separate from conversation history). Three
categories:
  profile — stable facts about who the user is
  note    — durable context/facts worth remembering
  pref    — learned preferences: how the assistant should work (self-improvement)
"""

import json
import os
import threading

from . import config

_lock = threading.Lock()
CATEGORIES = ("profile", "note", "pref")
MAX_ENTRIES = 200

_TITLES = {"profile": "Профиль", "note": "Заметки", "pref": "Предпочтения (как со мной работать)"}


def _path() -> str:
    return os.path.join(config.DATA_DIR, "memory.json")


def _read() -> list[dict]:
    try:
        with open(_path(), encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _write(entries: list[dict]) -> None:
    os.makedirs(config.DATA_DIR, exist_ok=True)
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _path())


def all_entries() -> list[dict]:
    with _lock:
        return _read()


def add(text: str, category: str = "note") -> dict:
    category = category if category in CATEGORIES else "note"
    with _lock:
        entries = _read()
        next_id = max((e["id"] for e in entries), default=0) + 1
        entry = {"id": next_id, "category": category, "text": text.strip()}
        entries.append(entry)
        _write(entries[-MAX_ENTRIES:])
        return entry


def remove(entry_id: int) -> bool:
    with _lock:
        entries = _read()
        kept = [e for e in entries if e["id"] != entry_id]
        if len(kept) == len(entries):
            return False
        _write(kept)
        return True


def as_prompt() -> str:
    """Render memory for injection into the system prompt (empty string if none)."""
    entries = all_entries()
    if not entries:
        return ""
    lines = ["## Долговременная память о пользователе (помни это всегда)"]
    for cat in CATEGORIES:
        items = [e for e in entries if e["category"] == cat]
        if not items:
            continue
        lines.append(f"### {_TITLES[cat]}")
        for e in items:
            lines.append(f"- (#{e['id']}) {e['text']}")
    return "\n".join(lines)
