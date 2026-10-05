import asyncio
import logging
import secrets
import string
import time
from collections.abc import Callable

from arena.game.map import load_map
from arena.game.results import MatchResult
from arena.game.room import MatchSettings, Room

CODE_ALPHABET = string.ascii_uppercase + string.digits
CODE_LENGTH = 4
_CODE_ATTEMPTS = 64

log = logging.getLogger("arena.rooms")


class RoomCodesExhausted(Exception):
    """No free room code could be found."""


class RoomRegistry:
    """Rooms live in process memory, which is why the server runs as a single worker."""

    def __init__(
        self,
        maps: tuple[str, ...],
        empty_ttl_s: float,
        clock: Callable[[], float] = time.monotonic,
        on_match_end: Callable[[MatchResult], None] | None = None,
    ) -> None:
        self.maps = maps
        """Names of the maps rooms may be played on."""
        self._empty_ttl_s = empty_ttl_s
        self._clock = clock
        self._on_match_end = on_match_end
        self._rooms: dict[str, Room] = {}

    def create(self, host_id: str, map_name: str, settings: MatchSettings) -> Room:
        self._sweep()
        for _ in range(_CODE_ATTEMPTS):
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
            if code not in self._rooms:
                room = Room(
                    code,
                    host_id,
                    settings,
                    load_map(map_name),
                    self._clock,
                    self._on_match_end,
                    self.maps,
                )
                self._rooms[code] = room
                log.info("room_created", extra={"room": code, "rooms": len(self._rooms)})
                return room
        raise RoomCodesExhausted

    def get(self, code: str) -> Room | None:
        room = self._rooms.get(code)
        if room is not None and self._expired(room):
            del self._rooms[code]
            return None
        return room

    def metrics(self) -> dict[str, float]:
        """Current load, for the /metrics endpoint."""
        rooms = list(self._rooms.values())
        ticks = [duration for room in rooms for duration in room.tick_durations]
        return {
            "arena_rooms": len(rooms),
            "arena_rooms_active": sum(1 for room in rooms if room.connected),
            "arena_players": sum(len(room.connected) for room in rooms),
            "arena_tick_seconds_avg": sum(ticks) / len(ticks) if ticks else 0.0,
            "arena_tick_seconds_max": max(ticks, default=0.0),
        }

    async def shutdown(self) -> None:
        """Stops every room. Matches in progress end here, so their results are not lost."""
        await asyncio.gather(*(room.stop() for room in self._rooms.values()))
        for room in self._rooms.values():
            room.finish_match()

    def _expired(self, room: Room) -> bool:
        return (
            room.empty_since is not None and self._clock() - room.empty_since >= self._empty_ttl_s
        )

    def _sweep(self) -> None:
        for code in [code for code, room in self._rooms.items() if self._expired(room)]:
            del self._rooms[code]
