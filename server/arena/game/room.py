import asyncio
import logging
import random
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from arena.db.players import Player
from arena.game.map import GameMap
from arena.game.movement import TICK_DT, InputCmd, PlayerState, create_player, step_player
from arena.net.protocol import PROTOCOL_VERSION, CloseCode, encode, state_json
from arena.shared import CONSTANTS

log = logging.getLogger("arena.room")

_NET = CONSTANTS["net"]
SNAPSHOT_INTERVAL: float = 1 / _NET["snapshotRate"]
# Inputs a client earns per server tick: one per simulation tick of real time.
INPUTS_PER_TICK: float = CONSTANTS["tickRate"] / _NET["snapshotRate"]
MAX_INPUT_BURST: float = _NET["maxInputBurst"]
MAX_QUEUED_INPUTS = 120


class RoomFull(Exception):
    """The room already has the maximum number of connected players."""


@dataclass(frozen=True)
class MatchSettings:
    mode: str
    kill_limit: int
    time_limit_min: int
    max_players: int


class Outbox(Protocol):
    """Where a room sends messages for one client. Must never block."""

    def send(self, text: str) -> None: ...

    def close(self, code: int) -> None: ...


@dataclass
class Member:
    """A player's slot in the room. Survives disconnects, so the score is kept."""

    player: Player
    state: PlayerState
    conn: Outbox | None = None
    kills: int = 0
    deaths: int = 0
    inputs: deque[tuple[int, InputCmd]] = field(default_factory=deque)
    last_seq: int = -1
    """Highest input sequence number received."""
    ack: int = -1
    """Highest input sequence number simulated."""
    credit: float = 0.0
    """How many inputs may still be simulated; refilled in real time."""


class Room:
    def __init__(
        self,
        code: str,
        host_id: str,
        settings: MatchSettings,
        game_map: GameMap,
        clock: Callable[[], float],
    ) -> None:
        self.code = code
        self.host_id = host_id
        self.settings = settings
        self.map = game_map
        self.members: dict[str, Member] = {}
        self.tick_no = 0
        # Set while nobody is connected; the registry drops the room once this is old enough.
        self.empty_since: float | None = clock()
        self._clock = clock
        self._task: asyncio.Task[None] | None = None

    @property
    def connected(self) -> list[Member]:
        return [member for member in self.members.values() if member.conn is not None]

    def join(self, player: Player, conn: Outbox) -> Member:
        member = self.members.get(player.id)
        rejoining = member is not None and member.conn is not None
        if member is not None and member.conn is not None:
            # The same player opened the game again; the newest connection wins.
            member.conn.close(CloseCode.REPLACED)
        elif len(self.connected) >= self.settings.max_players:
            raise RoomFull
        state = create_player(random.choice(self.map.spawns))
        if member is None:
            member = Member(player=player, state=state)
            self.members[player.id] = member
        member.player = player
        member.state = state
        member.conn = conn
        member.inputs.clear()
        member.last_seq = -1
        member.ack = -1
        member.credit = 0.0
        self.empty_since = None

        others = [m for m in self.connected if m is not member]
        conn.send(
            encode(
                {
                    "t": "welcome",
                    "v": PROTOCOL_VERSION,
                    "id": player.id,
                    "tick": self.tick_no,
                    "map": self.map.name,
                    "you": state_json(state),
                    "players": [_public(m.player) for m in others],
                }
            )
        )
        if not rejoining:
            self._broadcast({"t": "event", "e": "join", "player": _public(player)}, skip=member)
        return member

    def leave(self, member: Member, conn: Outbox) -> None:
        if member.conn is not conn:
            return  # Already replaced by a newer connection.
        member.conn = None
        member.inputs.clear()
        self._broadcast({"t": "event", "e": "leave", "id": member.player.id})
        if not self.connected:
            self.empty_since = self._clock()

    def receive_input(self, member: Member, seq: int, cmd: InputCmd) -> None:
        if seq <= member.last_seq or len(member.inputs) >= MAX_QUEUED_INPUTS:
            return
        member.last_seq = seq
        member.inputs.append((seq, cmd))

    def tick(self) -> None:
        """Simulates queued inputs and sends every client a snapshot."""
        self.tick_no += 1
        connected = self.connected
        for member in connected:
            # A client cannot move faster by sending inputs faster than real time.
            member.credit = min(member.credit + INPUTS_PER_TICK, MAX_INPUT_BURST)
            while member.inputs and member.credit >= 1:
                seq, cmd = member.inputs.popleft()
                member.credit -= 1
                member.ack = seq
                member.state = step_player(member.state, cmd, self.map, TICK_DT)
                if member.state.pos[1] < self.map.kill_y:
                    member.state = create_player(random.choice(self.map.spawns))

        views = {
            member.player.id: {
                "id": member.player.id,
                "pos": member.state.pos,
                "yaw": member.state.yaw,
                "crouched": member.state.crouched,
            }
            for member in connected
        }
        for member in connected:
            if member.conn is None:
                continue
            member.conn.send(
                encode(
                    {
                        "t": "snapshot",
                        "tick": self.tick_no,
                        "ack": member.ack,
                        "you": state_json(member.state),
                        "players": [v for pid, v in views.items() if pid != member.player.id],
                    }
                )
            )

    def ensure_running(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name=f"room-{self.code}")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        next_tick = loop.time()
        while self.connected:
            try:
                self.tick()
            except Exception:
                # One bad tick must not take the room down.
                log.exception("Tick failed in room %s", self.code)
            # Schedule against the ideal timeline, so sleep jitter does not accumulate.
            next_tick += SNAPSHOT_INTERVAL
            delay = next_tick - loop.time()
            if delay < -1:
                next_tick = loop.time()  # Stalled for too long to catch up; start over.
            await asyncio.sleep(max(delay, 0))

    def _broadcast(self, message: dict[str, Any], skip: Member | None = None) -> None:
        text = encode(message)
        for member in self.connected:
            if member is not skip and member.conn is not None:
                member.conn.send(text)


def _public(player: Player) -> dict[str, str]:
    """What other players may know about a player. Never includes the token."""
    return {"id": player.id, "name": player.name, "color": player.color}
