import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8000
    db_path: Path = Path("data/arena.db")
    client_dist: Path = REPO_ROOT / "client" / "dist"
    # How long a room with no players is kept before its code is freed.
    room_empty_ttl_s: float = 15 * 60

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        defaults = cls()
        return cls(
            host=env.get("ARENA_HOST", defaults.host),
            port=int(env.get("ARENA_PORT", defaults.port)),
            db_path=Path(env.get("ARENA_DB_PATH", defaults.db_path)),
            client_dist=Path(env.get("ARENA_CLIENT_DIST", defaults.client_dist)),
            room_empty_ttl_s=float(env.get("ARENA_ROOM_EMPTY_TTL_S", defaults.room_empty_ttl_s)),
        )
