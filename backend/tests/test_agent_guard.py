"""Запрет на rm: у Bash рабочая директория — корень вики, и стирание идёт мимо корзины."""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def decision(cmd: str):
    from app.agent import _no_rm_hook

    out = asyncio.run(_no_rm_hook({"tool_input": {"command": cmd}}, None, None))
    return out.get("hookSpecificOutput", {}).get("permissionDecision")


@pytest.mark.parametrize("cmd", [
    "rm -rf infra",
    "rm page.md",
    "cd content && rm -f note.md",
    "find . -name '*.tmp' -exec rm {} +",
    "sudo rm -rf /app/content",
])
def test_denied(cmd):
    assert decision(cmd) == "deny"


@pytest.mark.parametrize("cmd", [
    "mv page.md .trash/",
    "ls -la",
    "npm run build",
    "grep -rn rm content",
    "rm -f /tmp/scratch.json",
    "rm /var/tmp/a /tmp/b",
])
def test_allowed(cmd):
    assert decision(cmd) is None


# ── Библиотека книг: читать можно, писать нельзя ──


def write_decision(path: str):
    from app.agent import _books_ro_hook

    out = asyncio.run(_books_ro_hook({"tool_input": {"file_path": path}}, None, None))
    return out.get("hookSpecificOutput", {}).get("permissionDecision")


def test_в_книги_писать_нельзя():
    from app import config

    assert write_decision(os.path.join(config.BOOKS_DIR, "abc", "meta.json")) == "deny"


def test_остальное_пишется_как_раньше():
    from app import config

    assert write_decision(os.path.join(config.WIKI_DIR, "note.md")) is None
    # Похожее имя рядом с библиотекой — не библиотека
    assert write_decision(config.BOOKS_DIR + "-backup/x.md") is None
