import uvicorn

from arena.config import Settings


def main() -> None:
    settings = Settings.from_env()
    # Rooms live in process memory, so the server must run as a single worker.
    uvicorn.run("arena.main:app", host=settings.host, port=settings.port, workers=1)


if __name__ == "__main__":
    main()
