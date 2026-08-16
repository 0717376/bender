"""Один список доменных инструментов на оба движка.

Инструменты описаны один раз — декораторами Claude SDK в *_tools.py, у каждого есть
имя, описание, схема и обработчик. Claude получает их как внутрипроцессные MCP-серверы,
Codex — тем же набором, но по HTTP (см. mcp_internal.py). Разъезжаться этим двум
наборам нельзя: инструмент, который агент видит на одном движке и не видит на другом,
— это тихо разная функциональность у одного продукта.
"""

from . import (books_tools, config, cron_tools, memory_tools, session_tools, skill_tools,
               tasks_tools, telegram_tools)

# Имя группы = имя MCP-сервера у Claude и префикс имени инструмента у Codex.
GROUPS = {
    "tasks": tasks_tools,
    "skills": skill_tools,
    "sessions": session_tools,
    "tg": telegram_tools,
    "books": books_tools,
    "cron": cron_tools,
    "memory": memory_tools,
}

# Крон и запись в память — только в живом разговоре: в плановом запуске агент не должен
# заводить новый крон (рекурсия) и переписывать память без человека.
INTERACTIVE_ONLY = ("cron", "memory")

# Что доступно фоновому ревьюеру: он пишет память и навыки, и ничего больше.
REVIEWER_GROUPS = ("memory", "skills")


def groups_for(interactive: bool = True) -> tuple[str, ...]:
    return tuple(g for g in GROUPS if interactive or g not in INTERACTIVE_ONLY)


def tools_in(groups) -> list[tuple[str, object]]:
    """[(группа, инструмент)] в порядке групп — для регистрации и для тестов."""
    return [(g, t) for g in groups for t in GROUPS[g].TOOLS]


def tool_names(groups, engine: str = "") -> list[str]:
    return [config.tool_name(g, t.name, engine) for g, t in tools_in(groups)]


def sdk_servers(groups) -> dict:
    """Внутрипроцессные MCP-серверы для Claude SDK."""
    return {g: GROUPS[g].server for g in groups}


def find(group: str, name: str):
    for t in GROUPS[group].TOOLS:
        if t.name == name:
            return t
    return None
