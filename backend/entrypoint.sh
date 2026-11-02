#!/bin/sh
# Seed the Claude config (~/.claude.json) from a read-only mount, if provided.
# Auth credentials live in the mounted ~/.claude dir (token refresh persists there);
# .claude.json is copied into the container's HOME so the CLI can write to it freely.
if [ -f /seed/.claude.json ]; then
  cp -f /seed/.claude.json /root/.claude.json
fi

# Офисные навыки (docx, xlsx, pptx, pdf): лицензия не даёт положить их в репозиторий, поэтому
# ставятся с маркетплейса в смонтированный ~/.claude. Нет сети — запустимся без них.
CLAUDE_CLI=$(ls /app/.venv/lib/python*/site-packages/claude_agent_sdk/_bundled/claude 2>/dev/null | head -1)
if [ -n "$CLAUDE_CLI" ] && ! grep -qs "document-skills@anthropic-agent-skills" /root/.claude/plugins/installed_plugins.json; then
  { "$CLAUDE_CLI" plugin marketplace add anthropics/skills &&
    "$CLAUDE_CLI" plugin install document-skills@anthropic-agent-skills; } ||
    echo "office skills: не удалось поставить, продолжаю без них"
fi

exec uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
