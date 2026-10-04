import hashlib
import secrets
import time
from dataclasses import dataclass

from arena.db.database import Database


@dataclass(frozen=True)
class Player:
    id: str
    name: str
    color: str


def hash_token(token: str) -> str:
    # Tokens are long random strings, so a plain hash is enough to keep them out of the database.
    return hashlib.sha256(token.encode()).hexdigest()


async def create_player(db: Database, name: str, color: str) -> tuple[Player, str]:
    """Creates a player and returns it with the secret token, which is never stored."""
    player = Player(id=secrets.token_hex(8), name=name, color=color)
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    async with db.transaction() as conn:
        await conn.execute(
            "INSERT INTO players (id, token_hash, name, color, created_at, last_seen_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (player.id, hash_token(token), name, color, now, now),
        )
    return player, token


async def get_player_by_token(db: Database, token: str) -> Player | None:
    cursor = await db.conn.execute(
        "SELECT id, name, color FROM players WHERE token_hash = ?", (hash_token(token),)
    )
    row = await cursor.fetchone()
    return Player(id=row["id"], name=row["name"], color=row["color"]) if row else None


async def update_player(
    db: Database, player: Player, name: str | None, color: str | None
) -> Player:
    updated = Player(id=player.id, name=name or player.name, color=color or player.color)
    async with db.transaction() as conn:
        await conn.execute(
            "UPDATE players SET name = ?, color = ? WHERE id = ?",
            (updated.name, updated.color, updated.id),
        )
    return updated


async def touch_player(db: Database, player_id: str) -> None:
    async with db.transaction() as conn:
        await conn.execute(
            "UPDATE players SET last_seen_at = ? WHERE id = ?", (int(time.time()), player_id)
        )
