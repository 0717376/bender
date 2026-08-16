"""Движок на подписке Claude (Agent SDK).

Исторически это и был весь agent.py: доменные инструменты приезжают
внутрипроцессными MCP-серверами, навыки — локальными плагинами, запреты — хуками SDK.
"""

import logging
import os

from claude_agent_sdk import (
    AgentDefinition,
    AssistantMessage,
    ClaudeAgentOptions,
    HookMatcher,
    ResultMessage,
    StreamEvent,
    TextBlock,
    ToolUseBlock,
    query,
)

from .. import config, guards, skill_store, tool_registry
from . import Emit, Outcome, StaleSession

logger = logging.getLogger("wiki.agent.claude")

# Subagents the main agent can delegate to via the Task tool.
SUBAGENTS = {
    "researcher": AgentDefinition(
        description="Глубокий веб-ресёрч. Делегируй, когда нужно собрать и сверить информацию из "
        "интернета по теме. Возвращает краткую сводку фактов со ссылками.",
        prompt="Ты — исследователь. Тебе дают тему или вопрос. Сделай несколько веб-поисков "
        "(WebSearch), при необходимости открой страницы (WebFetch), сверь источники и верни "
        "сжатую фактическую сводку со ссылками. Не выдумывай; помечай неуверенность.",
        tools=["WebSearch", "WebFetch", "Read", "Grep", "Glob"],
        model="sonnet",
    ),
    "librarian": AgentDefinition(
        description="Реорганизация вики. Делегируй для крупных операций над базой знаний: "
        "навести порядок, разбить/объединить страницы, проставить ссылки.",
        prompt="Ты — библиотекарь персональной вики (markdown в рабочей директории). Аккуратно "
        "реорганизуй заметки по запросу: осмысленные имена, заголовки, относительные ссылки "
        "[текст](путь.md). Не теряй контент. По итогу кратко перечисли, что изменил.",
        tools=["Read", "Write", "Edit", "Grep", "Glob"],
        model="sonnet",
    ),
}


def _surface_nudge_hook(surface: str):
    """UserPromptSubmit hook that biases a domain frontend toward its native Skill.
    Returns None for surfaces with no nudge (Telegram/universal → model self-selects)."""
    nudge = config.SKILL_NUDGE.get(surface)
    if not nudge:
        return None

    async def hook(input_data, tool_use_id, context):  # noqa: ARG001 — SDK callback signature
        return {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": nudge,
            }
        }

    return hook


async def _no_rm_hook(input_data, tool_use_id, context):  # noqa: ARG001 — SDK callback signature
    if guards.rm_allowed((input_data.get("tool_input") or {}).get("command", "")):
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": guards.RM_DENIED,
        }
    }


async def _books_ro_hook(input_data, tool_use_id, context):  # noqa: ARG001 — SDK callback signature
    """Библиотека открыта агенту на чтение (иначе он не увидит рисунок), но не на запись:
    книги, прогресс и выписки правит сам человек в читалке."""
    path = os.path.abspath((input_data.get("tool_input") or {}).get("file_path") or "")
    if not path.startswith(config.BOOKS_DIR + os.sep):
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "В библиотеку книг писать нельзя: она открыта только на чтение "
                "(рисунки и страницы — инструментами chapter_images и page_image)."
            ),
        }
    }


def build_options(resume: str | None, surface: str, instructions: str,
                  interactive: bool = True) -> ClaudeAgentOptions:
    groups = tool_registry.groups_for(interactive)
    tools = config.ALLOWED_TOOLS + tool_registry.tool_names(groups, "claude")
    # Domain skills (wiki/tasks) are native SDK Skills loaded from our plugin dir. The Skill
    # tool is auto-added by the SDK when skills are enabled. A per-surface hook nudges the
    # domain frontends toward the right skill; Telegram gets none (model self-selects).
    hooks: dict = {"PreToolUse": [
        HookMatcher(matcher="Bash", hooks=[_no_rm_hook]),
        HookMatcher(matcher="Write", hooks=[_books_ro_hook]),
        HookMatcher(matcher="Edit", hooks=[_books_ro_hook]),
    ]}
    nudge = _surface_nudge_hook(surface)
    if nudge:
        hooks["UserPromptSubmit"] = [HookMatcher(hooks=[nudge])]
    # Enable ONLY our own skills by name — NOT "all". The mounted host ~/.claude carries the
    # official Claude plugin marketplace (code-review, deep-research, run, loop, …); skills="all"
    # would expose all of those. An explicit allow-list keeps the assistant self-contained:
    # domain wiki/tasks + whatever the agent has learned.
    allowed_skills = ["wiki", "tasks", "books"] + [s["slug"] for s in skill_store.list_skills()]
    return ClaudeAgentOptions(
        model=config.CLAUDE_MODEL,
        system_prompt={"type": "preset", "preset": "claude_code", "append": instructions},
        allowed_tools=tools,
        mcp_servers=tool_registry.sdk_servers(groups),
        agents=SUBAGENTS,
        plugins=[
            {"type": "local", "path": config.SKILL_PLUGIN_DIR},      # domain skills (wiki/tasks)
            {"type": "local", "path": config.LEARNED_PLUGIN_DIR},    # agent-authored skills
        ],
        skills=allowed_skills,
        hooks=hooks,
        cwd=config.WIKI_DIR,
        # Библиотека лежит вне рабочей директории, а Read по ней нужен: только так агент
        # видит рисунок из книги (пути выдают chapter_images/page_image). Запись закрыта
        # хуком выше.
        add_dirs=[config.BOOKS_DIR],
        include_partial_messages=True,
        resume=resume,
        # Don't inherit host ~/.claude project/user settings — keep the agent self-contained.
        # Skills come from `plugins` above, which is independent of setting_sources.
        setting_sources=None,
    )


def _error_text(m: ResultMessage) -> str:
    blob = " ".join(str(x) for x in (m.result, m.errors, m.api_error_status) if x).lower()
    if "context" in blob or "too long" in blob or "max tokens" in blob:
        return "Контекст сессии переполнен. Начните новую: /new в боте или «Очистить» в чате."
    return "Ошибка Claude. Попробуйте начать новую сессию (/new)."


def is_stale(exc: Exception) -> bool:
    return "No conversation found with session" in str(exc)


async def run(prompt: str, *, resume: str | None, surface: str, instructions: str,
              emit: Emit, interactive: bool = True) -> Outcome:
    options = build_options(resume, surface, instructions, interactive)
    out = Outcome(session_id=resume)
    texts: list[str] = []
    msg_id = ""
    try:
        async for m in query(prompt=prompt, options=options):
            if isinstance(m, StreamEvent):
                ev = m.event
                itype = ev.get("type", "")
                if itype == "message_start":
                    msg_id = ev.get("message", {}).get("id", msg_id)
                elif itype == "content_block_delta":
                    delta = ev.get("delta", {})
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        await emit({"t": "delta", "id": msg_id, "text": delta["text"]})
                elif itype == "content_block_stop":
                    await emit({"t": "flush", "id": msg_id})

            elif isinstance(m, AssistantMessage):
                msg_id = m.message_id or msg_id
                for block in m.content:
                    if isinstance(block, TextBlock) and block.text:
                        texts.append(block.text)
                        await emit({"t": "text", "id": msg_id, "text": block.text})
                    elif isinstance(block, ToolUseBlock):
                        inp = block.input or {}
                        await emit({
                            "t": "tool",
                            "name": block.name or "",
                            "pattern": (inp.get("pattern") or inp.get("command", ""))[:80],
                            "file": inp.get("file_path", ""),
                        })

            elif isinstance(m, ResultMessage):
                out.session_id = m.session_id or resume
                if m.is_error:
                    out.error = _error_text(m)
                elif m.result:
                    out.reply = m.result
    except Exception as e:
        if is_stale(e):
            raise StaleSession from e
        raise
    if not out.reply:
        out.reply = "\n\n".join(texts)
    return out


async def review(prompt: str, instructions: str) -> None:
    """Фоновый ревьюер: свой промпт, только память и навыки, без общей сессии."""
    options = ClaudeAgentOptions(
        model=config.REVIEWER_MODEL,
        system_prompt=instructions,
        allowed_tools=tool_registry.tool_names(tool_registry.REVIEWER_GROUPS, "claude"),
        mcp_servers=tool_registry.sdk_servers(tool_registry.REVIEWER_GROUPS),
        cwd=config.DATA_DIR,
        resume=None,
        max_turns=6,
        setting_sources=None,
    )
    async for _ in query(prompt=prompt, options=options):
        pass
