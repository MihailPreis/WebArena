# syntax=docker/dockerfile:1

# --- Client: static files built by Vite -------------------------------------
FROM node:24-slim AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
# The client imports constants and maps from ../shared.
COPY shared/ /app/shared/
COPY client/ ./
RUN npm run build

# --- Server: virtual environment with the application installed --------------
FROM python:3.13-slim AS server
COPY --from=ghcr.io/astral-sh/uv:0.6 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app/server
# Dependencies first, so this layer is reused until the lock file changes.
COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY server/arena ./arena
RUN uv sync --frozen --no-dev --no-editable

# --- Final image --------------------------------------------------------------
FROM python:3.13-slim
RUN useradd --system --uid 10001 --no-create-home arena \
    && mkdir /data \
    && chown arena /data

# Same path as in the build stage: a virtual environment is not relocatable.
COPY --from=server /app/server/.venv /app/server/.venv
COPY --from=client /app/client/dist /app/client
COPY shared/ /app/shared/

ENV PATH=/app/server/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    ARENA_HOST=0.0.0.0 \
    ARENA_PORT=8000 \
    ARENA_DB_PATH=/data/arena.db \
    ARENA_CLIENT_DIST=/app/client \
    ARENA_SHARED_DIR=/app/shared

USER arena
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"ARENA_PORT\"]}/healthz', timeout=3)"]

# One process, one worker: rooms live in memory.
CMD ["python", "-m", "arena"]
