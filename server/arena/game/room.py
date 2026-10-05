import asyncio
import dataclasses
import logging
import math
import time
import unicodedata
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from arena.db.players import Player
from arena.game.combat import (
    Target,
    aim_direction,
    box_distance,
    eye_position,
    is_clear,
    pellet_directions,
    player_box,
    trace_shot,
)
from arena.game.items import AMMO, ARMOR, HEALTH, ITEM_TYPES, PICKUP_RADIUS, WEAPON, ItemSpec
from arena.game.map import GameMap, Vec3, load_map
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
from arena.game.weapon import (
    PROJECTILE,
    WEAPONS,
    WeaponSpec,
    WeaponState,
    give_ammo,
    give_weapon,
    step_weapon,
)
from arena.net.protocol import PROTOCOL_VERSION, CloseCode, encode, state_json
from arena.ratelimit import RateLimiter
from arena.shared import CONSTANTS

log = logging.getLogger("arena.room")

_NET = CONSTANTS["net"]
_COMBAT = CONSTANTS["combat"]
_ROCKET = CONSTANTS["rocket"]

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
MAX_ARMOR: int = _COMBAT["maxArmor"]
# The share of damage that armour takes instead of health, while there is any.
ARMOR_ABSORB: float = _COMBAT["armorAbsorb"]
QUAD_MULTIPLIER: float = _COMBAT["quadMultiplier"]
QUAD_S: float = _COMBAT["quadS"]

_ROCKET_SPEC: WeaponSpec = next(spec for spec in WEAPONS if spec.kind == PROJECTILE)
ROCKET_SPEED: float = _ROCKET["speed"]
ROCKET_LIFE_S: float = _ROCKET["lifeS"]
SPLASH_RADIUS: float = _ROCKET["splashRadius"]
SELF_DAMAGE: float = _ROCKET["selfDamage"]
# Speed a blast gives a player, in metres per second per point of damage.
KNOCKBACK: float = _ROCKET["knockback"]

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
class Rocket:
    id: int
    owner: str
    """Public id of the player who fired it."""
    pos: Vec3
    direction: Vec3
    dies_at: float
    """Game time at which it blows up in the air."""


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
    armor: int = 0
    alive: bool = True
    quad_until: float = 0.0
    """Game time until which the player's damage is multiplied."""
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
        maps: tuple[str, ...] = (),
    ) -> None:
        self.code = code
        self.host_id = host_id
        self.settings = settings
        self.map = game_map
        # Names of the maps the host may switch to.
        self._maps = maps
        self.mode = MODES[settings.mode]
        self.members: dict[str, Member] = {}
        self.tick_no = 0
        self.state = WAITING
        self.state_ends_at: float | None = None
        self._arrivals = 0
        self._on_match_end = on_match_end
        self._match_started_at = 0
        self.rockets: list[Rocket] = []
        self._rocket_seq = 0
        # Game time at which each item of the map is back; in the past for those present.
        self.item_back_at: list[float] = [0.0] * len(game_map.items)
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
        self, member: Member, mode: str, map_name: str, kill_limit: int, time_limit_min: int
    ) -> None:
        """Lets the host change the rules and the map, but only between matches."""
        if member.player.id != self.host_id or self.state == MATCH:
            return
        if map_name != self.map.name and map_name in self._maps:
            # Clients load the new map when they see its name in the room state.
            self.map = load_map(map_name)
            self.item_back_at = [0.0] * len(self.map.items)
            self.rockets.clear()
            for m in self.connected:
                self._respawn(m)
            log.info("map_changed", extra={"room": self.code, "map": map_name})
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

    def update_player(self, player: Player) -> None:
        """Shows a renamed or recoloured player to the room straight away."""
        member = self.members.get(player.id)
        if member is None or member.player == player:
            return
        member.player = player
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
                    self._fall(member)
                    continue
                member.weapon, fired = step_weapon(member.weapon, cmd.fire, cmd.weapon)
                if fired:
                    self._fire(member, cmd, queued.render_time)
                self._collect(member)

        if frozen:
            self.rockets.clear()
        else:
            self._step_rockets()

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
                "quad": now < member.quad_until,
            }
            for member in connected
            if member.alive
        }
        # Bit `i` is set while item `i` of the map is there to be picked up.
        items = sum(1 << i for i, back_at in enumerate(self.item_back_at) if back_at <= now)
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
                        "items": items,
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
        index = shooter.weapon.current
        spec = WEAPONS[index]
        shooter.protected_until = 0.0  # Attacking gives up spawn protection.
        if self.state == MATCH:
            shooter.shots += 1
        origin = eye_position(shooter.state)
        if spec.kind == PROJECTILE:
            self._rocket_seq += 1
            direction = aim_direction(cmd.yaw, cmd.pitch)
            self.rockets.append(
                Rocket(self._rocket_seq, shooter.player.id, origin, direction, now + ROCKET_LIFE_S)
            )
            # The shooter gets it too, to learn the number of the rocket it has already drawn.
            self._broadcast(
                {
                    "t": "event",
                    "e": "rocket",
                    "n": self._rocket_seq,
                    "id": shooter.player.id,
                    "from": origin,
                    "dir": direction,
                }
            )
            return

        # Judge the shot against what the shooter saw: other players are drawn slightly
        # in the past, so rewind them to that moment, within a bounded window.
        seen_at = min(max(render_time, now - MAX_REWIND_S), now)
        targets = [
            Target(m.player.id, *_position_at(m, seen_at))
            for m in self.connected
            if m.alive and self.mode.are_enemies(shooter, m)
        ]
        ends: list[Vec3] = []
        # Pellets of one shot add up: the target is told about the shot, not about each pellet.
        hits: dict[str, tuple[float, bool]] = {}
        for direction in pellet_directions(cmd.yaw, cmd.pitch, spec.pellets, spec.spread):
            result = trace_shot(self.map, origin, direction, targets)
            ends.append(result.end)
            if result.target_id is None:
                continue
            head = result.head and spec.head_multiplier > 1
            amount, any_head = hits.get(result.target_id, (0.0, False))
            amount += spec.damage * (spec.head_multiplier if head else 1)
            hits[result.target_id] = (amount, any_head or head)
        self._broadcast(
            {
                "t": "event",
                "e": "shot",
                "id": shooter.player.id,
                "w": index,
                "from": origin,
                "to": ends,
            },
            skip=shooter,
        )
        landed = [
            head
            for target_id, (amount, head) in hits.items()
            if self._damage(shooter, self.members[target_id], amount, head, shooter.state.pos)
        ]
        if landed and self.state == MATCH:
            shooter.hits += 1
            shooter.headshots += any(landed)

    def _damage(
        self, attacker: Member, target: Member, amount: float, head: bool, origin: Vec3
    ) -> bool:
        """Hurts `target`; armour takes its share first. `origin` is where the damage came
        from, for the target's direction indicator. Returns whether anything was dealt.
        """
        now = self.time
        if not target.alive or now < target.protected_until:
            return False
        own = attacker is target
        if not own and now < attacker.quad_until:
            amount *= QUAD_MULTIPLIER
        damage = round(amount)
        if damage <= 0:
            return False
        absorbed = min(target.armor, math.ceil(damage * ARMOR_ABSORB))
        taken = min(damage - absorbed, target.hp)
        target.armor -= absorbed
        target.hp -= taken
        counted = self.state == MATCH
        if counted:
            target.damage_taken += absorbed + taken
            if not own:
                attacker.damage_dealt += absorbed + taken
        hit = encode(
            {
                "t": "event",
                "e": "hit",
                "by": attacker.player.id,
                "target": target.player.id,
                "dmg": damage,
                "head": head,
                "from": origin,
            }
        )
        for involved in {id(attacker): attacker, id(target): target}.values():
            if involved.conn is not None:
                involved.conn.send(hit)
        if target.hp == 0:
            target.alive = False
            target.respawn_at = now + RESPAWN_DELAY_S
            target.quad_until = 0.0
            target.history.clear()
            if counted and own:
                self.mode.record_suicide(target)
            elif counted:
                self.mode.record_kill(attacker, target)
            self._broadcast(
                {
                    "t": "event",
                    "e": "kill",
                    "by": attacker.player.id,
                    "target": target.player.id,
                    "head": head,
                    "fall": False,
                }
            )
        return True

    def _fall(self, member: Member) -> None:
        """The player has fallen off the map: a death by their own hand."""
        member.alive = False
        member.hp = 0
        member.respawn_at = self.time + RESPAWN_DELAY_S
        member.quad_until = 0.0
        member.history.clear()
        if self.state == MATCH:
            self.mode.record_suicide(member)
        self._broadcast(
            {
                "t": "event",
                "e": "kill",
                "by": member.player.id,
                "target": member.player.id,
                "head": False,
                "fall": True,
            }
        )

    def _step_rockets(self) -> None:
        now = self.time
        step = ROCKET_SPEED * SNAPSHOT_INTERVAL
        for rocket in list(self.rockets):
            owner = self.members.get(rocket.owner)
            # Rockets fly in the present: unlike bullets they are not rewound, the
            # shooter has to lead the target.
            targets = [
                Target(m.player.id, m.state.pos, m.state.crouched)
                for m in self.connected
                if m.alive and owner is not None and self.mode.are_enemies(owner, m)
            ]
            result = trace_shot(self.map, rocket.pos, rocket.direction, targets, limit=step)
            if result.distance < step or now >= rocket.dies_at:
                self._explode(rocket, result.end, result.target_id)
            else:
                rocket.pos = result.end

    def _explode(self, rocket: Rocket, point: Vec3, direct_id: str | None) -> None:
        self.rockets.remove(rocket)
        self._broadcast({"t": "event", "e": "explode", "n": rocket.id, "pos": point})
        owner = self.members.get(rocket.owner)
        if owner is None:
            return
        spec = _ROCKET_SPEC
        # The point lies on the surface that was hit; look around from just in front of it.
        d = rocket.direction
        vantage = (point[0] - d[0] * 0.05, point[1] - d[1] * 0.05, point[2] - d[2] * 0.05)
        landed = False
        for member in self.connected:
            if not member.alive or self.time < member.protected_until:
                continue
            if member is not owner and not self.mode.are_enemies(owner, member):
                continue
            lo, hi = player_box(member.state.pos, member.state.crouched)
            centre = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
            if member.player.id == direct_id:
                amount = float(spec.damage)
            else:
                distance = box_distance(point, lo, hi)
                if distance >= SPLASH_RADIUS or not is_clear(self.map, vantage, centre):
                    continue
                amount = spec.damage * (1 - distance / SPLASH_RADIUS)
            # The blast throws the player away from its centre, the shooter included:
            # that is what a rocket jump is.
            away = (centre[0] - point[0], centre[1] - point[1], centre[2] - point[2])
            length = math.hypot(*away)
            push = amount * KNOCKBACK / length if length > 0 else 0.0
            vel = member.state.vel
            member.state = dataclasses.replace(
                member.state,
                vel=(vel[0] + away[0] * push, vel[1] + away[1] * push, vel[2] + away[2] * push),
                on_ground=False,
            )
            if member is owner:
                self._damage(owner, owner, amount * SELF_DAMAGE, False, point)
            elif self._damage(owner, member, amount, False, point):
                landed = True
        if landed and self.state == MATCH:
            owner.hits += 1

    def _collect(self, member: Member) -> None:
        """Gives the player the items they are standing on, if they have a use for them."""
        now = self.time
        x, y, z = member.state.pos
        _, top = player_box(member.state.pos, member.state.crouched)
        for index, item in enumerate(self.map.items):
            if self.item_back_at[index] > now:
                continue
            ix, iy, iz = item.position
            if math.hypot(ix - x, iz - z) > PICKUP_RADIUS or not y - 0.5 <= iy <= top[1]:
                continue
            spec = ITEM_TYPES[item.type]
            if not self._take(member, spec):
                continue
            self.item_back_at[index] = now + spec.respawn_s
            self._broadcast({"t": "event", "e": "pickup", "id": member.player.id, "item": index})

    def _take(self, member: Member, spec: ItemSpec) -> bool:
        """Applies an item to a player. False if it would give them nothing."""
        if spec.kind in (WEAPON, AMMO):
            give = give_weapon if spec.kind == WEAPON else give_ammo
            weapon = give(member.weapon, spec.weapon)
            if weapon is None:
                return False
            member.weapon = weapon
        elif spec.kind == HEALTH:
            if member.hp >= MAX_HEALTH:
                return False
            member.hp = min(member.hp + spec.amount, MAX_HEALTH)
        elif spec.kind == ARMOR:
            if member.armor >= MAX_ARMOR:
                return False
            member.armor = min(member.armor + spec.amount, MAX_ARMOR)
        else:
            member.quad_until = self.time + QUAD_S
        return True

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
        # A new match starts with every item in place and nothing in the air.
        self.item_back_at = [0.0] * len(self.map.items)
        self.rockets.clear()
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
        member.armor = 0
        member.alive = True
        member.weapon = WeaponState()
        member.quad_until = 0.0
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
                    "map": self.map.name,
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
            "armor": member.armor,
            "alive": member.alive,
            "frozen": self.state == RESULTS,
            "weapon": member.weapon.current,
            "ammo": member.weapon.ammo,
            "owned": member.weapon.owned,
            "cooldown": member.weapon.cooldown,
            # Seconds of the damage booster left.
            "quad": round(max(member.quad_until - self.time, 0.0), 1),
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
