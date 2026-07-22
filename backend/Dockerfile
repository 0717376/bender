FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

WORKDIR /app

# Node.js for the Claude CLI (the Agent SDK drives it under the hood).
# poppler-utils: pdftoppm/pdftotext — the Read tool renders PDF pages with it.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl git tzdata poppler-utils && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Claude CLI
RUN npm install -g @anthropic-ai/claude-code

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev || uv sync

COPY app ./app
COPY agent_skills ./agent_skills
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

EXPOSE 8000

CMD ["./entrypoint.sh"]
