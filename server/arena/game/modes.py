"""Game modes. A mode owns the rules of a match — scoring, the win condition, the
ranking and where players spawn — so the room does not need to know them.
Team deathmatch will be added here as a second mode.
"""

from __future__ import annotations

import math
import random
from collections.abc import Sequence
from typing import TYPE_CHECKING, Protocol

from arena.game.map import GameMap, Spawn

if TYPE_CHECKING:
    from arena.game.room import MatchSettings, Member


class GameMode(Protocol):
    def record_kill(self, killer: Member, victim: Member) -> None:
        """Updates the score after a kill."""

    def is_won(self, members: Sequence[Member], settings: MatchSettings) -> bool:
        """True once the score ends the match. The time limit is the room's concern."""

    def ranking(self, members: Sequence[Member]) -> list[Member]:
        """Members from first place to last."""

    def pick_spawn(self, game_map: GameMap, member: Member, others: Sequence[Member]) -> Spawn:
        """Where `member` should appear; `others` are the living players around."""


class Deathmatch:
    """Free for all: every kill is a point, the first to the kill limit wins."""

    def record_kill(self, killer: Member, victim: Member) -> None:
        killer.kills += 1
        victim.deaths += 1

    def is_won(self, members: Sequence[Member], settings: MatchSettings) -> bool:
        return any(member.kills >= settings.kill_limit for member in members)

    def ranking(self, members: Sequence[Member]) -> list[Member]:
        return sorted(members, key=lambda member: (-member.kills, member.deaths, member.joined))

    def pick_spawn(self, game_map: GameMap, member: Member, others: Sequence[Member]) -> Spawn:
        # As far as possible from everyone else, since everyone is an opponent.
        if not others:
            return random.choice(game_map.spawns)
        return max(
            game_map.spawns,
            key=lambda spawn: min(math.dist(spawn.position, other.state.pos) for other in others),
        )


MODES: dict[str, GameMode] = {"deathmatch": Deathmatch()}
