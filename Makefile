.PHONY: install dev dev-server dev-client test lint format build vectors

install:
	cd server && uv sync
	cd client && npm install

# Server with reload on :8000 and Vite on :5173 (proxies /api, /ws, /healthz to the server).
dev:
	$(MAKE) -j2 dev-server dev-client

dev-server:
	cd server && ARENA_RELOAD=1 ARENA_DEV_MAPS=1 uv run python -m arena

dev-client:
	cd client && npm run dev

test:
	cd server && uv run pytest
	cd client && npm test

lint:
	cd server && uv run ruff check . && uv run ruff format --check . && uv run mypy
	cd client && npm run typecheck && npm run lint

format:
	cd server && uv run ruff check --fix . && uv run ruff format .
	cd client && npm run format

build:
	cd client && npm run build

# Regenerate shared/movement_vectors.json from the client simulation (the reference).
vectors:
	cd client && UPDATE_VECTORS=1 npx vitest run src/game/sim/vectors.test.ts
	cd server && uv run pytest tests/test_movement_vectors.py
