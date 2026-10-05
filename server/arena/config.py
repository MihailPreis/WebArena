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
    # Kills a player needs before appearing in the K/D leaderboard.
    leaderboard_min_kills: int = 20
    leaderboard_cache_s: float = 15
    # New profiles and rooms allowed per minute from one address; 0 disables the limit.
    profiles_per_minute: float = 10
    rooms_per_minute: float = 6
    # Simultaneous game connections from one address; 0 disables the limit.
    ws_max_per_ip: int = 16
    # Addresses of reverse proxies whose X-Forwarded-For header is trusted ("*" for any).
    trusted_proxies: str = "127.0.0.1"
    # Offer the small test maps as well; meant for development.
    dev_maps: bool = False
    log_json: bool = False
    reload: bool = False

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
            leaderboard_min_kills=int(
                env.get("ARENA_LEADERBOARD_MIN_KILLS", defaults.leaderboard_min_kills)
            ),
            leaderboard_cache_s=float(
                env.get("ARENA_LEADERBOARD_CACHE_S", defaults.leaderboard_cache_s)
            ),
            profiles_per_minute=float(
                env.get("ARENA_PROFILES_PER_MINUTE", defaults.profiles_per_minute)
            ),
            rooms_per_minute=float(env.get("ARENA_ROOMS_PER_MINUTE", defaults.rooms_per_minute)),
            ws_max_per_ip=int(env.get("ARENA_WS_MAX_PER_IP", defaults.ws_max_per_ip)),
            trusted_proxies=env.get("ARENA_TRUSTED_PROXIES", defaults.trusted_proxies),
            dev_maps=env.get("ARENA_DEV_MAPS", "") == "1",
            log_json=env.get("ARENA_LOG_JSON", "") == "1",
            reload=env.get("ARENA_RELOAD", "") == "1",
        )
