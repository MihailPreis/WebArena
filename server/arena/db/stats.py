from dataclasses import dataclass
from typing import Literal

import aiosqlite

from arena.db.database import Database
from arena.game.results import MatchResult

LeaderboardKind = Literal["kd", "kills", "wins"]
LEADERBOARD_SIZE = 10

_TOTALS = (
    "matches",
    "wins",
    "kills",
    "deaths",
    "headshots",
    "shots",
    "hits",
    "damage_dealt",
    "damage_taken",
    "playtime_s",
)

# A player who has not died yet counts as having died once.
_KD = "CAST(s.kills AS REAL) / MAX(s.deaths, 1)"

_ORDER: dict[LeaderboardKind, str] = {
    "kd": f"{_KD} DESC, s.kills DESC",
    "kills": "s.kills DESC, s.deaths ASC",
    "wins": "s.wins DESC, s.kills DESC",
}


@dataclass(frozen=True)
class PlayerStats:
    id: str
    name: str
    color: str
    matches: int
    wins: int
    kills: int
    deaths: int
    headshots: int
    shots: int
    hits: int
    damage_dealt: int
    damage_taken: int
    playtime_s: int

    @property
    def kd(self) -> float:
        return self.kills / max(self.deaths, 1)

    @property
    def accuracy(self) -> float:
        """Share of shots that hit, 0 to 1."""
        return self.hits / self.shots if self.shots else 0.0


def _stats(row: aiosqlite.Row) -> PlayerStats:
    return PlayerStats(
        id=row["id"],
        name=row["name"],
        color=row["color"],
        **{column: row[column] or 0 for column in _TOTALS},
    )


async def save_match(db: Database, result: MatchResult) -> None:
    """Stores a match and adds it to the players' totals, all or nothing."""
    async with db.transaction() as conn:
        cursor = await conn.execute(
            "INSERT INTO matches"
            " (room_code, map, mode, kill_limit, time_limit_s, started_at, ended_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                result.room_code,
                result.map,
                result.mode,
                result.kill_limit,
                result.time_limit_s,
                result.started_at,
                result.ended_at,
            ),
        )
        match_id = cursor.lastrowid
        for p in result.players:
            counters = (
                p.kills,
                p.deaths,
                p.headshots,
                p.shots,
                p.hits,
                p.damage_dealt,
                p.damage_taken,
                p.playtime_s,
            )
            await conn.execute(
                "INSERT INTO match_players (match_id, player_id, kills, deaths, headshots, shots,"
                " hits, damage_dealt, damage_taken, playtime_s, place, won, team)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (match_id, p.player_id, *counters, p.place, int(p.won), p.team),
            )
            await conn.execute(
                "INSERT INTO player_stats (player_id, matches, wins, kills, deaths, headshots,"
                " shots, hits, damage_dealt, damage_taken, playtime_s)"
                " VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT (player_id) DO UPDATE SET "
                + ", ".join(f"{column} = {column} + excluded.{column}" for column in _TOTALS),
                (p.player_id, int(p.won), *counters),
            )


async def leaderboard(db: Database, by: LeaderboardKind, min_kills: int) -> list[PlayerStats]:
    """The best players. `min_kills` keeps one lucky match out of the K/D ranking."""
    # Players with no kills at all are left out of every ranking.
    threshold = min_kills if by == "kd" else 1
    cursor = await db.conn.execute(
        "SELECT p.id, p.name, p.color, s.* FROM player_stats s"
        " JOIN players p ON p.id = s.player_id"
        f" WHERE s.kills >= ? ORDER BY {_ORDER[by]} LIMIT {LEADERBOARD_SIZE}",
        (threshold,),
    )
    return [_stats(row) for row in await cursor.fetchall()]


async def player_stats(db: Database, player_id: str) -> PlayerStats | None:
    """Totals of one player; all zeros if they have not finished a match. None if unknown."""
    cursor = await db.conn.execute(
        "SELECT p.id, p.name, p.color, s.* FROM players p"
        " LEFT JOIN player_stats s ON s.player_id = p.id WHERE p.id = ?",
        (player_id,),
    )
    row = await cursor.fetchone()
    return _stats(row) if row else None
