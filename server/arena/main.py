import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from arena.config import Settings

ROOM_CODE_RE = re.compile(r"[A-Z0-9]{4}")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(title="Arena", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings

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
