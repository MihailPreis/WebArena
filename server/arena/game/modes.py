"""Game modes. A mode owns the rules of a match — who fights whom, scoring, the win
condition, the ranking and where players spawn — so the room does not need to know them.
"""

from __future__ import annotations

import math
import random
from collections.abc import Sequence
from typing import TYPE_CHECKING, Protocol

from arena.game.map import GameMap, Spawn

if TYPE_CHECKING:
    from arena.game.room import MatchSettings, Member

TEAMS = ("blue", "red")


class GameMode(Protocol):
    def assign_team(self, member: Member, others: Sequence[Member]) -> str | None:
        """The team `member` should be on, or None if the mode has no teams.
        `others` are the players already in the room.
        """

    def are_enemies(self, a: Member, b: Member) -> bool:
        """Whether `a` can hurt `b`."""

    def record_kill(self, killer: Member, victim: Member) -> None:
        """Updates the score after a kill."""

    def is_won(self, members: Sequence[Member], settings: MatchSettings) -> bool:
        """True once the score ends the match. The time limit is the room's concern."""

    def ranking(self, members: Sequence[Member]) -> list[Member]:
        """Members from first place to last."""

    def winners(self, members: Sequence[Member]) -> list[Member]:
        """Who won the match; empty for a draw."""

    def team_scores(self, members: Sequence[Member]) -> dict[str, int] | None:
        """Score of each team, or None if the mode has no teams."""

    def pick_spawn(self, game_map: GameMap, member: Member, enemies: Sequence[Member]) -> Spawn:
        """Where `member` should appear; `enemies` are the living opponents."""


def _farthest_spawn(game_map: GameMap, enemies: Sequence[Member]) -> Spawn:
    if not enemies:
        return random.choice(game_map.spawns)
    return max(
        game_map.spawns,
        key=lambda spawn: min(math.dist(spawn.position, enemy.state.pos) for enemy in enemies),
    )


class Deathmatch:
    """Free for all: every kill is a point, the first to the kill limit wins."""

    def assign_team(self, member: Member, others: Sequence[Member]) -> str | None:
        return None

    def are_enemies(self, a: Member, b: Member) -> bool:
        return a is not b

    def record_kill(self, killer: Member, victim: Member) -> None:
        killer.kills += 1
        victim.deaths += 1

    def is_won(self, members: Sequence[Member], settings: MatchSettings) -> bool:
        return any(member.kills >= settings.kill_limit for member in members)

    def ranking(self, members: Sequence[Member]) -> list[Member]:
        return sorted(members, key=lambda member: (-member.kills, member.deaths, member.joined))

    def winners(self, members: Sequence[Member]) -> list[Member]:
        ranked = self.ranking(members)
        if not ranked or ranked[0].kills == 0:
            return []
        first = ranked[0]
        level = len(ranked) > 1 and (ranked[1].kills, ranked[1].deaths) == (
            first.kills,
            first.deaths,
        )
        return [] if level else [first]

    def team_scores(self, members: Sequence[Member]) -> dict[str, int] | None:
        return None

    def pick_spawn(self, game_map: GameMap, member: Member, enemies: Sequence[Member]) -> Spawn:
        return _farthest_spawn(game_map, enemies)


class TeamDeathmatch:
    """Two teams. A team's score is the kills of its players; the kill limit applies to it.
    Teammates cannot hurt each other.
    """

    def assign_team(self, member: Member, others: Sequence[Member]) -> str | None:
        if member.team in TEAMS:
            return member.team  # Coming back keeps the side.
        sizes = {team: sum(1 for other in others if other.team == team) for team in TEAMS}
        return min(TEAMS, key=lambda team: sizes[team])

    def are_enemies(self, a: Member, b: Member) -> bool:
        return a.team != b.team

    def record_kill(self, killer: Member, victim: Member) -> None:
        killer.kills += 1
        victim.deaths += 1

    def team_scores(self, members: Sequence[Member]) -> dict[str, int]:
        return {
            team: sum(member.kills for member in members if member.team == team) for team in TEAMS
        }

    def is_won(self, members: Sequence[Member], settings: MatchSettings) -> bool:
        return max(self.team_scores(members).values()) >= settings.kill_limit

    def ranking(self, members: Sequence[Member]) -> list[Member]:
        scores = self.team_scores(members)
        return sorted(
            members,
            key=lambda member: (
                -scores.get(member.team or "", 0),
                TEAMS.index(member.team) if member.team in TEAMS else len(TEAMS),
                -member.kills,
                member.deaths,
                member.joined,
            ),
        )

    def winners(self, members: Sequence[Member]) -> list[Member]:
        scores = self.team_scores(members)
        best = max(scores.values())
        leaders = [team for team, score in scores.items() if score == best]
        if best == 0 or len(leaders) != 1:
            return []
        return [member for member in members if member.team == leaders[0]]

    def pick_spawn(self, game_map: GameMap, member: Member, enemies: Sequence[Member]) -> Spawn:
        return _farthest_spawn(game_map, enemies)


MODES: dict[str, GameMode] = {"deathmatch": Deathmatch(), "team-deathmatch": TeamDeathmatch()}
