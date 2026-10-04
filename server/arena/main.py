import asyncio
import logging
import re
from collections import Counter
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from arena.api import leaderboard, players, rooms
from arena.config import Settings
from arena.db.database import Database
from arena.db.stats import save_match
from arena.game.map import load_map
from arena.game.results import MatchResult
from arena.game.rooms import RoomRegistry
from arena.net import ws
from arena.ratelimit import RateLimiter

ROOM_CODE_RE = re.compile(r"[A-Z0-9]{4}")

log = logging.getLogger("arena")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db = Database(settings.db_path)
        await db.connect()
        app.state.db = db
        try:
            yield
        finally:
            # Order matters: end running matches, let their results be written, then close.
            await app.state.rooms.shutdown()
            await asyncio.gather(*saves)
            await db.close()

    app = FastAPI(title="Arena", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    # The game script is over half a megabyte; compressed it is a quarter of that.
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.state.settings = settings
    app.state.leaderboard_cache = {}
    app.state.ws_connections = Counter()
    app.state.limiters = {
        "profiles": RateLimiter(settings.profiles_per_minute / 60, settings.profiles_per_minute),
        "rooms": RateLimiter(settings.rooms_per_minute / 60, settings.rooms_per_minute),
    }
    matches_saved = 0

    saves: set[asyncio.Task[None]] = set()

    async def save(result: MatchResult) -> None:
        nonlocal matches_saved
        try:
            await save_match(app.state.db, result)
            app.state.leaderboard_cache.clear()
            matches_saved += 1
            log.info("match_saved", extra={"room": result.room_code})
        except Exception:
            log.exception("match_not_saved", extra={"room": result.room_code})

    def on_match_end(result: MatchResult) -> None:
        # Written in the background: the game loop must not wait for the database.
        task = asyncio.create_task(save(result))
        saves.add(task)
        task.add_done_callback(saves.discard)

    app.state.rooms = RoomRegistry(
        load_map("arena"), empty_ttl_s=settings.room_empty_ttl_s, on_match_end=on_match_end
    )
    app.include_router(players.router)
    app.include_router(rooms.router)
    app.include_router(leaderboard.router)
    app.include_router(ws.router)

    def page(name: str) -> FileResponse:
        path: Path = settings.client_dist / name
        if not path.is_file():
            # In development the client is served by Vite, not by this server.
            raise HTTPException(status_code=404, detail="Client is not built; run `make build`.")
        return FileResponse(path)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/metrics", response_class=PlainTextResponse)
    async def metrics() -> str:
        """Load figures in the Prometheus text format."""
        values = {**app.state.rooms.metrics(), "arena_matches_saved_total": matches_saved}
        return "".join(f"{name} {value:g}\n" for name, value in values.items())

    @app.get("/")
    async def index() -> FileResponse:
        return page("index.html")

    @app.get("/game/{code}")
    async def game(code: str) -> FileResponse:
        if not ROOM_CODE_RE.fullmatch(code):
            raise HTTPException(status_code=404, detail="Invalid room code.")
        return page("game.html")

    assets = settings.client_dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    return app


app = create_app()
