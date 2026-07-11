#!/bin/sh
# Seed the Claude config (~/.claude.json) from a read-only mount, if provided.
# Auth credentials live in the mounted ~/.claude dir (token refresh persists there);
# .claude.json is copied into the container's HOME so the CLI can write to it freely.
if [ -f /seed/.claude.json ]; then
  cp -f /seed/.claude.json /root/.claude.json
fi

exec uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
