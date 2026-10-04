import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from arena.api import players, rooms
from arena.config import Settings
from arena.db.database import Database
from arena.game.rooms import RoomRegistry

ROOM_CODE_RE = re.compile(r"[A-Z0-9]{4}")


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
            await db.close()

    app = FastAPI(title="Arena", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.settings = settings
    app.state.rooms = RoomRegistry(empty_ttl_s=settings.room_empty_ttl_s)
    app.include_router(players.router)
    app.include_router(rooms.router)

    def page(name: str) -> FileResponse:
        path: Path = settings.client_dist / name
        if not path.is_file():
            # In development the client is served by Vite, not by this server.
            raise HTTPException(status_code=404, detail="Client is not built; run `make build`.")
        return FileResponse(path)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

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
