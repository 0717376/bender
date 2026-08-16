"""Запрет на rm: у шелла рабочая директория — корень вики, и стирание идёт мимо корзины.

Правило одно на оба движка, поэтому и проверяем оба: хук Claude SDK и скрипт-хук Codex.
Разъедутся — и на одной подписке вики защищена, а на другой нет.
"""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def decision(cmd: str):
    from app.engines.claude import _no_rm_hook

    out = asyncio.run(_no_rm_hook({"tool_input": {"command": cmd}}, None, None))
    return out.get("hookSpecificOutput", {}).get("permissionDecision")


def codex_decision(cmd, event="PreToolUse"):
    from app.codex_hook import decide

    out = decide({"hook_event_name": event, "tool_name": "shell", "tool_input": {"command": cmd}})
    return out.get("hookSpecificOutput", {}).get("permissionDecision")


@pytest.mark.parametrize("cmd", [
    "rm -rf infra",
    "rm page.md",
    "cd content && rm -f note.md",
    "find . -name '*.tmp' -exec rm {} +",
    "sudo rm -rf /app/content",
    # Обёртка оболочкой — самый простой способ обойти запрет, если его не разворачивать
    'bash -lc "rm -rf infra"',
    "sh -c 'cd content && rm note.md'",
])
def test_denied(cmd):
    assert decision(cmd) == "deny"
    assert codex_decision(cmd) == "deny"


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
    assert codex_decision(cmd) is None


def patch_decision(tool, command):
    from app.codex_hook import decide

    out = decide({"hook_event_name": "PreToolUse", "tool_name": tool,
                  "tool_input": {"command": command}})
    return out.get("hookSpecificOutput", {}).get("permissionDecision")


def test_патчем_в_книги_не_пишут():
    """У Claude библиотеку закрывает хук на Write/Edit; у Codex правки приезжают
    патчем — правило должно действовать и там."""
    from app import config

    assert patch_decision("apply_patch",
                          f"*** Begin Patch\n*** Update File: {config.BOOKS_DIR}/a/meta.json\n") == "deny"
    assert patch_decision("apply_patch",
                          f"*** Begin Patch\n*** Update File: {config.WIKI_DIR}/note.md\n") is None


def test_патчем_не_удаляют():
    """`*** Delete File:` — то же стирание мимо корзины, что и rm."""
    from app import config

    assert patch_decision("apply_patch",
                          f"*** Begin Patch\n*** Delete File: {config.WIKI_DIR}/note.md\n") == "deny"


def test_codex_видит_команду_списком():
    """Шелл у Codex приезжает и массивом аргументов — разбирать надо и такое."""
    from app.codex_hook import decide

    out = decide({"hook_event_name": "PreToolUse",
                  "tool_input": {"command": ["bash", "-lc", "rm -rf infra"]}})
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


# ── Библиотека книг: читать можно, писать нельзя ──


def write_decision(path: str):
    from app.engines.claude import _books_ro_hook

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
