import asyncio
import secrets
import string
import time
from collections.abc import Callable

from arena.game.map import GameMap
from arena.game.room import MatchSettings, Room

CODE_ALPHABET = string.ascii_uppercase + string.digits
CODE_LENGTH = 4
_CODE_ATTEMPTS = 64


class RoomCodesExhausted(Exception):
    """No free room code could be found."""


class RoomRegistry:
    """Rooms live in process memory, which is why the server runs as a single worker."""

    def __init__(
        self,
        game_map: GameMap,
        empty_ttl_s: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._map = game_map
        self._empty_ttl_s = empty_ttl_s
        self._clock = clock
        self._rooms: dict[str, Room] = {}

    def create(self, host_id: str, settings: MatchSettings) -> Room:
        self._sweep()
        for _ in range(_CODE_ATTEMPTS):
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
            if code not in self._rooms:
                room = Room(code, host_id, settings, self._map, self._clock)
                self._rooms[code] = room
                return room
        raise RoomCodesExhausted

    def get(self, code: str) -> Room | None:
        room = self._rooms.get(code)
        if room is not None and self._expired(room):
            del self._rooms[code]
            return None
        return room

    async def shutdown(self) -> None:
        await asyncio.gather(*(room.stop() for room in self._rooms.values()))

    def _expired(self, room: Room) -> bool:
        return (
            room.empty_since is not None and self._clock() - room.empty_since >= self._empty_ttl_s
        )

    def _sweep(self) -> None:
        for code in [code for code, room in self._rooms.items() if self._expired(room)]:
            del self._rooms[code]
