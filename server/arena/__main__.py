import uvicorn

from arena.config import Settings
from arena.logs import log_config

# Client messages are a few hundred bytes; anything much larger is not a game client.
WS_MAX_MESSAGE_BYTES = 4096


def main() -> None:
    settings = Settings.from_env()
    uvicorn.run(
        "arena.main:app",
        host=settings.host,
        port=settings.port,
        # Rooms live in process memory, so the server must run as a single worker.
        workers=1,
        reload=settings.reload,
        ws_max_size=WS_MAX_MESSAGE_BYTES,
        proxy_headers=True,
        forwarded_allow_ips=settings.trusted_proxies,
        log_config=log_config(settings.log_json),
    )


if __name__ == "__main__":
    main()
