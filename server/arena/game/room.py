import asyncio
import dataclasses
import logging
import math
import random
import time
import unicodedata
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from arena.db.players import Player
from arena.game.combat import Target, aim_direction, eye_position, trace_shot
from arena.game.map import GameMap, Vec3
from arena.game.modes import MODES, TEAMS
from arena.game.movement import (
    TICK_DT,
    InputCmd,
    PlayerState,
    create_player,
    is_dashing,
    step_player,
)
from arena.game.results import MatchResult, PlayerResult
from arena.game.weapon import WeaponState, step_weapon
from arena.net.protocol import PROTOCOL_VERSION, CloseCode, encode, state_json
from arena.ratelimit import RateLimiter
from arena.shared import CONSTANTS

log = logging.getLogger("arena.room")

_NET = CONSTANTS["net"]
_COMBAT = CONSTANTS["combat"]
_WEAPON = CONSTANTS["weapon"]

SNAPSHOT_INTERVAL: float = 1 / _NET["snapshotRate"]
# Inputs a client earns per server tick: one per simulation tick of real time.
INPUTS_PER_TICK: float = CONSTANTS["tickRate"] / _NET["snapshotRate"]
MAX_INPUT_BURST: float = _NET["maxInputBurst"]
MAX_QUEUED_INPUTS = 120
HISTORY_S: float = _NET["historyS"]
MAX_REWIND_S: float = _NET["maxRewindS"]
# A jump this large between two history samples is a respawn; mirrors the client's interpolation.
TELEPORT_DISTANCE = 5.0

MAX_HEALTH: int = _COMBAT["maxHealth"]
RESPAWN_DELAY_S: float = _COMBAT["respawnDelayS"]
SPAWN_PROTECTION_S: float = _COMBAT["spawnProtectionS"]
DAMAGE: int = _WEAPON["damage"]
HEAD_MULTIPLIER: float = _WEAPON["headMultiplier"]

MIN_PLAYERS: int = CONSTANTS["match"]["minPlayers"]
RESULTS_S: float = CONSTANTS["match"]["resultsS"]
ROOM_STATE_INTERVAL_TICKS: int = round(_NET["roomStateIntervalS"] * _NET["snapshotRate"])

# A player may say a few lines at once, then one every couple of seconds.
CHAT_BURST = 4
CHAT_PER_SECOND = 0.5

# Room states. Scores only count during a match.
WAITING = "waiting"  # Fewer players than a match needs; everyone can roam and shoot.
MATCH = "match"
RESULTS = "results"  # The match is over: players are frozen and the final table is shown.


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


@dataclass(frozen=True)
class QueuedInput:
    seq: int
    cmd: InputCmd
    render_time: float
    """Server time at which the client was drawing other players when it sent this input."""


@dataclass
class Member:
    """A player's slot in the room. Survives disconnects, so the score is kept."""

    player: Player
    state: PlayerState
    conn: Outbox | None = None
    kills: int = 0
    deaths: int = 0
    team: str | None = None
    """Side in a team mode; None in a free-for-all."""
    joined: int = 0
    """Order of arrival; the longest-present player inherits the host role."""
    ping: int = 0
    """Round-trip time in milliseconds, as measured and reported by the client."""
    # Counted during a match only and saved with its result.
    headshots: int = 0
    shots: int = 0
    hits: int = 0
    damage_dealt: int = 0
    damage_taken: int = 0
    playtime_s: float = 0.0
    hp: int = MAX_HEALTH
    alive: bool = True
    weapon: WeaponState = field(default_factory=WeaponState)
    respawn_at: float = 0.0
    protected_until: float = 0.0
    inputs: deque[QueuedInput] = field(default_factory=deque)
    last_seq: int = -1
    """Highest input sequence number received."""
    ack: int = -1
    """Highest input sequence number simulated."""
    credit: float = 0.0
    """How many inputs may still be simulated; refilled in real time."""
    history: deque[tuple[float, Vec3, bool]] = field(default_factory=deque)
    """Recent (time, position, crouched) samples, for lag compensation."""


class Room:
    def __init__(
        self,
        code: str,
        host_id: str,
        settings: MatchSettings,
        game_map: GameMap,
        clock: Callable[[], float],
        on_match_end: Callable[[MatchResult], None] | None = None,
    ) -> None:
        self.code = code
        self.host_id = host_id
        self.settings = settings
        self.map = game_map
        self.mode = MODES[settings.mode]
        self.members: dict[str, Member] = {}
        self.tick_no = 0
        self.state = WAITING
        self.state_ends_at: float | None = None
        self._arrivals = 0
        self._on_match_end = on_match_end
        self._match_started_at = 0
        # How long recent ticks took, in seconds: about ten seconds' worth.
        self.tick_durations: deque[float] = deque(maxlen=300)
        # Set while nobody is connected; the registry drops the room once this is old enough.
        self.empty_since: float | None = clock()
        self._clock = clock
        # Keyed by player and run on game time, so reconnecting does not refill it.
        self._chat_limit = RateLimiter(CHAT_PER_SECOND, CHAT_BURST, clock=lambda: self.time)
        self._task: asyncio.Task[None] | None = None

    @property
    def connected(self) -> list[Member]:
        return [member for member in self.members.values() if member.conn is not None]

    @property
    def time(self) -> float:
        """Game time in seconds. Clients derive the same value from the snapshot tick."""
        return self.tick_no * SNAPSHOT_INTERVAL

    def join(self, player: Player, conn: Outbox) -> Member:
        member = self.members.get(player.id)
        rejoining = member is not None and member.conn is not None
        if member is not None and member.conn is not None:
            # The same player opened the game again; the newest connection wins.
            member.conn.close(CloseCode.REPLACED)
        elif len(self.connected) >= self.settings.max_players:
            raise RoomFull
        if member is None:
            member = Member(player=player, state=create_player(self.map.spawns[0]))
            self.members[player.id] = member
        if not rejoining:
            self._arrivals += 1
            member.joined = self._arrivals
            host = self.members.get(self.host_id)
            # A host who has been here and left is replaced by whoever comes next.
            if host is not None and host.conn is None and not self.connected:
                self.host_id = player.id
        member.player = player
        member.conn = conn
        member.inputs.clear()
        member.last_seq = -1
        member.ack = -1
        member.credit = 0.0
        member.team = self.mode.assign_team(member, [m for m in self.connected if m is not member])
        self._spawn(member)
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
                    "you": state_json(member.state),
                    "status": self._status(member),
                    "players": [_public(m) for m in others],
                }
            )
        )
        if not rejoining:
            self._broadcast({"t": "event", "e": "join", "player": _public(member)}, skip=member)
        self._send_room_state()
        log.info(
            "player_joined",
            extra={"room": self.code, "player": player.id, "players": len(self.connected)},
        )
        return member

    def leave(self, member: Member, conn: Outbox) -> None:
        if member.conn is not conn:
            return  # Already replaced by a newer connection.
        member.conn = None
        member.inputs.clear()
        member.history.clear()
        self._broadcast({"t": "event", "e": "leave", "id": member.player.id})
        connected = self.connected
        if connected and member.player.id == self.host_id:
            self.host_id = min(connected, key=lambda m: m.joined).player.id
        if not connected:
            self.empty_since = self._clock()
        self._send_room_state()
        log.info(
            "player_left",
            extra={"room": self.code, "player": member.player.id, "players": len(connected)},
        )

    def change_settings(
        self, member: Member, mode: str, kill_limit: int, time_limit_min: int
    ) -> None:
        """Lets the host change the rules, but only between matches."""
        if member.player.id != self.host_id or self.state == MATCH:
            return
        if mode != self.settings.mode:
            self.mode = MODES[mode]
            # Deal the sides afresh, in order of arrival, so they come out even.
            members = sorted(self.members.values(), key=lambda m: m.joined)
            for m in members:
                m.team = None
            for i, m in enumerate(members):
                m.team = self.mode.assign_team(m, members[:i])
        self.settings = dataclasses.replace(
            self.settings, mode=mode, kill_limit=kill_limit, time_limit_min=time_limit_min
        )
        self._send_room_state()

    def change_team(self, member: Member, team: str) -> None:
        """Moves a player to the other side. During a match this costs a life."""
        if member.team not in TEAMS or team not in TEAMS or team == member.team:
            return
        others = [m for m in self.connected if m is not member]
        joining = sum(1 for m in others if m.team == team) + 1
        leaving = sum(1 for m in others if m.team == member.team)
        if joining - leaving > 1:
            return  # Would leave the sides uneven by more than one player.
        member.team = team
        self._broadcast({"t": "event", "e": "team", "id": member.player.id, "team": team})
        if self.state == MATCH and member.alive:
            member.alive = False
            member.hp = 0
            member.deaths += 1
            member.respawn_at = self.time + RESPAWN_DELAY_S
            member.history.clear()
        elif self.state == WAITING:
            self._respawn(member)
        self._send_room_state()
        log.info(
            "team_changed", extra={"room": self.code, "player": member.player.id, "team": team}
        )

    def chat(self, member: Member, text: str) -> None:
        """Passes a player's line on to everyone in the room, the sender included."""
        text = _clean_chat(text)
        if not text or not self._chat_limit.allow(member.player.id):
            return
        self._broadcast({"t": "event", "e": "chat", "id": member.player.id, "text": text})

    def receive_input(self, member: Member, seq: int, cmd: InputCmd, render_time: float) -> None:
        if seq <= member.last_seq or len(member.inputs) >= MAX_QUEUED_INPUTS:
            return
        member.last_seq = seq
        member.inputs.append(QueuedInput(seq, cmd, render_time))

    def tick(self) -> None:
        """Simulates queued inputs and sends every client a snapshot."""
        self.tick_no += 1
        now = self.time
        connected = self.connected
        self._update_match(now)
        frozen = self.state == RESULTS

        for member in connected:
            if not member.alive and now >= member.respawn_at and not frozen:
                self._respawn(member)

        for member in connected:
            # A client cannot act faster by sending inputs faster than real time.
            member.credit = min(member.credit + INPUTS_PER_TICK, MAX_INPUT_BURST)
            while member.inputs and member.credit >= 1:
                queued = member.inputs.popleft()
                member.credit -= 1
                member.ack = queued.seq
                if not member.alive or frozen:
                    continue  # Acknowledged, but the dead and the frozen cannot act.
                cmd = queued.cmd
                member.state = step_player(member.state, cmd, self.map, TICK_DT)
                if member.state.pos[1] < self.map.kill_y:
                    member.state = create_player(random.choice(self.map.spawns))
                member.weapon, fired = step_weapon(member.weapon, cmd.fire, cmd.reload)
                if fired:
                    self._fire(member, cmd, queued.render_time)

        for member in connected:
            if self.state == MATCH:
                member.playtime_s += SNAPSHOT_INTERVAL
            if member.alive:
                member.history.append((now, member.state.pos, member.state.crouched))
                while member.history[0][0] < now - HISTORY_S:
                    member.history.popleft()

        views = {
            member.player.id: {
                "id": member.player.id,
                # Other players are only drawn, so millimetres are enough; this keeps
                # snapshots small. The receiver's own state stays exact for prediction.
                "pos": [round(axis, 3) for axis in member.state.pos],
                "yaw": round(member.state.yaw, 3),
                "crouched": member.state.crouched,
                "dashing": is_dashing(member.state),
            }
            for member in connected
            if member.alive
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
                        "status": self._status(member),
                        "players": [v for pid, v in views.items() if pid != member.player.id],
                    }
                )
            )
        if self.tick_no % ROOM_STATE_INTERVAL_TICKS == 0:
            self._send_room_state()  # Keeps pings and the match clock fresh on clients.

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
            started = time.perf_counter()
            try:
                self.tick()
            except Exception:
                # One bad tick must not take the room down.
                log.exception("tick_failed", extra={"room": self.code})
            self.tick_durations.append(time.perf_counter() - started)
            # Schedule against the ideal timeline, so sleep jitter does not accumulate.
            next_tick += SNAPSHOT_INTERVAL
            delay = next_tick - loop.time()
            if delay < -1:
                next_tick = loop.time()  # Stalled for too long to catch up; start over.
            await asyncio.sleep(max(delay, 0))
        self.tick_durations.clear()  # An idle room should not skew the load figures.

    def _fire(self, shooter: Member, cmd: InputCmd, render_time: float) -> None:
        now = self.time
        counted = self.state == MATCH
        shooter.protected_until = 0.0  # Attacking gives up spawn protection.
        if counted:
            shooter.shots += 1
        # Judge the shot against what the shooter saw: other players are drawn slightly
        # in the past, so rewind them to that moment, within a bounded window.
        seen_at = min(max(render_time, now - MAX_REWIND_S), now)
        targets = [
            Target(m.player.id, *_position_at(m, seen_at))
            for m in self.connected
            if m.alive and self.mode.are_enemies(shooter, m)
        ]
        origin = eye_position(shooter.state)
        result = trace_shot(self.map, origin, aim_direction(cmd.yaw, cmd.pitch), targets)
        self._broadcast(
            {
                "t": "event",
                "e": "shot",
                "id": shooter.player.id,
                "from": origin,
                "to": result.end,
            },
            skip=shooter,
        )
        if result.target_id is None:
            return
        target = self.members[result.target_id]
        if now < target.protected_until:
            return
        damage = round(DAMAGE * HEAD_MULTIPLIER) if result.head else DAMAGE
        if counted:
            shooter.hits += 1
            shooter.headshots += result.head
            shooter.damage_dealt += min(damage, target.hp)
            target.damage_taken += min(damage, target.hp)
        target.hp = max(target.hp - damage, 0)
        hit = encode(
            {
                "t": "event",
                "e": "hit",
                "by": shooter.player.id,
                "target": target.player.id,
                "dmg": damage,
                "head": result.head,
                "from": shooter.state.pos,
            }
        )
        for involved in (shooter, target):
            if involved.conn is not None:
                involved.conn.send(hit)
        if target.hp == 0:
            target.alive = False
            target.respawn_at = now + RESPAWN_DELAY_S
            target.history.clear()
            if counted:
                self.mode.record_kill(shooter, target)
            self._broadcast(
                {
                    "t": "event",
                    "e": "kill",
                    "by": shooter.player.id,
                    "target": target.player.id,
                    "head": result.head,
                }
            )

    def _update_match(self, now: float) -> None:
        if self.state == WAITING:
            if len(self.connected) >= MIN_PLAYERS:
                self._start_match(now)
        elif self.state == MATCH:
            timed_out = self.state_ends_at is not None and now >= self.state_ends_at
            if timed_out or self.mode.is_won(list(self.members.values()), self.settings):
                self.finish_match()
        elif self.state_ends_at is not None and now >= self.state_ends_at:
            if len(self.connected) >= MIN_PLAYERS:
                self._start_match(now)
            else:
                self._reset_scores()
                self.state = WAITING
                self.state_ends_at = None
                for member in self.connected:
                    self._respawn(member)
                self._send_room_state()

    def finish_match(self) -> None:
        """Ends the running match, if any, and reports its result. Also used on shutdown."""
        if self.state != MATCH:
            return
        self.state = RESULTS
        self.state_ends_at = self.time + RESULTS_S
        self._send_room_state()
        members = list(self.members.values())
        winners = self.mode.winners(members)
        log.info(
            "match_ended",
            extra={
                "room": self.code,
                "players": len(members),
                "kills": sum(member.kills for member in members),
                "mode": self.settings.mode,
                "winners": [member.player.id for member in winners],
            },
        )
        if self._on_match_end is None:
            return
        self._on_match_end(
            MatchResult(
                room_code=self.code,
                map=self.map.name,
                mode=self.settings.mode,
                kill_limit=self.settings.kill_limit,
                time_limit_s=self.settings.time_limit_min * 60,
                started_at=self._match_started_at,
                ended_at=int(time.time()),
                players=tuple(
                    PlayerResult(
                        player_id=member.player.id,
                        kills=member.kills,
                        deaths=member.deaths,
                        headshots=member.headshots,
                        shots=member.shots,
                        hits=member.hits,
                        damage_dealt=member.damage_dealt,
                        damage_taken=member.damage_taken,
                        playtime_s=round(member.playtime_s),
                        place=place,
                        won=member in winners,
                        team=member.team,
                    )
                    for place, member in enumerate(self.mode.ranking(members), start=1)
                ),
            )
        )

    def _start_match(self, now: float) -> None:
        self._reset_scores()
        self._match_started_at = int(time.time())
        self.state = MATCH
        self.state_ends_at = now + self.settings.time_limit_min * 60
        log.info("match_started", extra={"room": self.code, "players": len(self.connected)})
        for member in self.connected:
            self._respawn(member)
        self._send_room_state()

    def _reset_scores(self) -> None:
        # Players who left stay in the table only until the match they played in is over.
        self.members = {pid: m for pid, m in self.members.items() if m.conn is not None}
        for member in self.members.values():
            member.kills = member.deaths = member.headshots = 0
            member.shots = member.hits = 0
            member.damage_dealt = member.damage_taken = 0
            member.playtime_s = 0.0

    def _respawn(self, member: Member) -> None:
        self._spawn(member)
        self._broadcast(
            {"t": "event", "e": "spawn", "id": member.player.id, "yaw": member.state.yaw}
        )

    def _spawn(self, member: Member) -> None:
        enemies = [m for m in self.connected if m.alive and self.mode.are_enemies(member, m)]
        member.state = create_player(self.mode.pick_spawn(self.map, member, enemies))
        member.hp = MAX_HEALTH
        member.alive = True
        member.weapon = WeaponState()
        member.protected_until = self.time + SPAWN_PROTECTION_S
        member.history.clear()

    def _send_room_state(self) -> None:
        """Tells everyone the match state, the rules and the score table."""
        time_left = None if self.state_ends_at is None else max(self.state_ends_at - self.time, 0)
        self._broadcast(
            {
                "t": "room",
                "state": self.state,
                "timeLeft": time_left,
                "hostId": self.host_id,
                "teams": self.mode.team_scores(list(self.members.values())),
                "settings": {
                    "mode": self.settings.mode,
                    "killLimit": self.settings.kill_limit,
                    "timeLimitMin": self.settings.time_limit_min,
                    "maxPlayers": self.settings.max_players,
                },
                "players": [
                    {
                        **_public(member),
                        "kills": member.kills,
                        "deaths": member.deaths,
                        "ping": member.ping,
                        "online": member.conn is not None,
                    }
                    for member in self.mode.ranking(list(self.members.values()))
                ],
            }
        )

    def _status(self, member: Member) -> dict[str, Any]:
        """The private part of a player's state: only that player receives it."""
        return {
            "hp": member.hp,
            "alive": member.alive,
            "frozen": self.state == RESULTS,
            "ammo": member.weapon.ammo,
            "cooldown": member.weapon.cooldown,
            "reload": member.weapon.reload,
        }

    def _broadcast(self, message: dict[str, Any], skip: Member | None = None) -> None:
        text = encode(message)
        for member in self.connected:
            if member is not skip and member.conn is not None:
                member.conn.send(text)


def _position_at(member: Member, time: float) -> tuple[Vec3, bool]:
    """Where a player was at `time`, interpolated the way clients interpolate snapshots."""
    history = member.history
    if not history or time >= history[-1][0]:
        return member.state.pos, member.state.crouched
    if time <= history[0][0]:
        return history[0][1], history[0][2]
    for i in range(len(history) - 1, 0, -1):
        t0, p0, c0 = history[i - 1]
        t1, p1, c1 = history[i]
        if t0 <= time:
            if math.dist(p0, p1) >= TELEPORT_DISTANCE:
                return p1, c1
            alpha = (time - t0) / (t1 - t0)
            pos = (
                p0[0] + (p1[0] - p0[0]) * alpha,
                p0[1] + (p1[1] - p0[1]) * alpha,
                p0[2] + (p1[2] - p0[2]) * alpha,
            )
            return pos, (c0 if alpha < 0.5 else c1)
    return history[0][1], history[0][2]


def _clean_chat(text: str) -> str:
    """One line of printable text: no control characters, runs of whitespace as one space."""
    printable = "".join(
        " " if char.isspace() else char
        for char in text
        if char.isspace() or not unicodedata.category(char).startswith("C")
    )
    return " ".join(printable.split())


def _public(member: Member) -> dict[str, str | None]:
    """What other players may know about a player. Never includes the token."""
    player = member.player
    return {"id": player.id, "name": player.name, "color": player.color, "team": member.team}
