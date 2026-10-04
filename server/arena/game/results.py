from dataclasses import dataclass


@dataclass(frozen=True)
class PlayerResult:
    player_id: str
    kills: int
    deaths: int
    headshots: int
    shots: int
    hits: int
    damage_dealt: int
    damage_taken: int
    playtime_s: int
    place: int
    won: bool


@dataclass(frozen=True)
class MatchResult:
    """Everything worth keeping about a finished match."""

    room_code: str
    map: str
    mode: str
    kill_limit: int
    time_limit_s: int
    started_at: int
    """Unix time."""
    ended_at: int
    players: tuple[PlayerResult, ...]
