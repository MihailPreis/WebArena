import math

import pytest

from arena.db.players import Player
from arena.game.combat import Target, aim_direction, ray_box, trace_shot
from arena.game.map import Block, GameMap, Spawn, Vec3, load_map
from arena.game.movement import InputCmd, PlayerState
from arena.game.room import (
    DAMAGE,
    MAX_HEALTH,
    MAX_REWIND_S,
    RESPAWN_DELAY_S,
    SNAPSHOT_INTERVAL,
    SPAWN_PROTECTION_S,
    MatchSettings,
    Member,
    Room,
)
from arena.game.weapon import FIRE_INTERVAL_TICKS, MAGAZINE, RELOAD_TICKS, WeaponState, step_weapon
from tests.conftest import FakeConn

ARENA = load_map("arena")
ALICE = Player("a1", "Alice", "#ff5555")
BOB = Player("b2", "Bob", "#54a0ff")
CAROL = Player("c3", "Carol", "#2ed573")

# Open floor with one wall across z = -10, for shots with nothing else in the way.
RANGE = GameMap(
    "range",
    -20.0,
    (
        Block((-50.0, -1.0, -50.0), (50.0, 0.0, 50.0), "floor"),
        Block((-50.0, 0.0, -11.0), (50.0, 5.0, -10.0), "wall"),
    ),
    (Spawn((0.0, 0.0, 0.0), 0.0), Spawn((0.0, 0.0, 30.0), 0.0), Spawn((40.0, 0.0, 40.0), 0.0)),
)


def standing(pos: Vec3, yaw: float = 0.0, crouched: bool = False) -> PlayerState:
    return PlayerState(pos, (0.0, 0.0, 0.0), yaw, 0.0, True, crouched, False)


def cmd(yaw: float = 0.0, pitch: float = 0.0, fire: bool = False, reload: bool = False) -> InputCmd:
    return InputCmd(0.0, 0.0, False, False, False, yaw, pitch, fire, reload)


class Duel:
    """Alice at the origin looking along -z, Bob five metres in front of her."""

    def __init__(self, game_map: GameMap = RANGE) -> None:
        self.room = Room("AB12", ALICE.id, MatchSettings("deathmatch", 25, 10, 8), game_map, float)
        self.alice_conn, self.bob_conn = FakeConn(), FakeConn()
        self.alice = self.room.join(ALICE, self.alice_conn)
        self.bob = self.room.join(BOB, self.bob_conn)
        self.room.tick()  # Two players are present: the match starts and respawns them.
        self.alice.state = standing((0.0, 0.0, 0.0))
        self.bob.state = standing((0.0, 0.0, -5.0))
        for member in (self.alice, self.bob):
            member.history.clear()
        self.seq = 0
        self.wait(SPAWN_PROTECTION_S + 0.1)

    def wait(self, seconds: float) -> None:
        for _ in range(math.ceil(seconds / SNAPSHOT_INTERVAL)):
            self.room.tick()

    def act(self, member: Member, command: InputCmd, render_time: float | None = None) -> None:
        """Sends one input and lets the server simulate it."""
        self.seq += 1
        seen_at = self.room.time if render_time is None else render_time
        self.room.receive_input(member, self.seq, command, seen_at)
        self.room.tick()

    def shoot(self, pitch: float = 0.0, yaw: float = 0.0) -> None:
        self.act(self.alice, cmd(yaw, pitch, fire=True))
        # Let the weapon cool down so the next call fires again.
        for _ in range(FIRE_INTERVAL_TICKS):
            self.act(self.alice, cmd(yaw, pitch))

    def events(self, conn: FakeConn, kind: str) -> list[dict[str, object]]:
        return [m for m in conn.sent if m.get("e") == kind]


def test_ray_box() -> None:
    lo, hi = (-1.0, 0.0, -6.0), (1.0, 2.0, -5.0)
    assert ray_box((0, 1, 0), (0, 0, -1), lo, hi) == 5
    assert ray_box((0, 1, 0), (0, 0, 1), lo, hi) is None
    assert ray_box((3, 1, 0), (0, 0, -1), lo, hi) is None
    assert ray_box((0, 1, -5.5), (0, 0, -1), lo, hi) == 0
    assert ray_box((0, 5, 0), (0, -1, 0), lo, hi) is None


def test_aim_direction() -> None:
    assert aim_direction(0, 0) == pytest.approx((0, 0, -1))
    assert aim_direction(math.pi / 2, 0) == pytest.approx((-1, 0, 0))
    assert aim_direction(0, math.pi / 2) == pytest.approx((0, 1, 0), abs=1e-12)


def test_trace_shot_picks_the_nearest_target_and_respects_walls() -> None:
    near = Target("near", (0.0, 0.0, -4.0), False)
    far = Target("far", (0.0, 0.0, -8.0), False)
    hidden = Target("hidden", (0.0, 0.0, -15.0), False)
    origin, forward = (0.0, 1.0, 0.0), (0.0, 0.0, -1.0)

    assert trace_shot(RANGE, origin, forward, [far, near]).target_id == "near"
    blocked = trace_shot(RANGE, origin, forward, [hidden])
    assert blocked.target_id is None
    assert blocked.end == pytest.approx((0, 1, -10))


def test_head_zone_is_the_top_of_the_hitbox() -> None:
    target = Target("t", (0.0, 0.0, -5.0), False)
    crouching = Target("t", (0.0, 0.0, -5.0), True)
    forward = (0.0, 0.0, -1.0)
    assert trace_shot(RANGE, (0.0, 1.0, 0.0), forward, [target]).head is False
    assert trace_shot(RANGE, (0.0, 1.7, 0.0), forward, [target]).head is True
    assert trace_shot(RANGE, (0.0, 1.0, 0.0), forward, [crouching]).head is True
    assert trace_shot(RANGE, (0.0, 1.7, 0.0), forward, [crouching]).target_id is None


def test_weapon_fire_rate_magazine_and_reload() -> None:
    weapon = WeaponState()
    shots = 0
    for _ in range(FIRE_INTERVAL_TICKS * 3):
        weapon, fired = step_weapon(weapon, True, False)
        shots += fired
    assert shots == 3
    assert weapon.ammo == MAGAZINE - 3

    # Holding fire empties the magazine, then reloads on its own.
    ticks = 0
    while weapon.ammo > 0:
        weapon, _ = step_weapon(weapon, True, False)
        ticks += 1
    weapon, fired = step_weapon(weapon, True, False)
    assert not fired
    assert weapon.reload == RELOAD_TICKS
    for _ in range(RELOAD_TICKS - 1):
        weapon, fired = step_weapon(weapon, True, False)
        assert not fired
    weapon, _ = step_weapon(weapon, True, False)
    assert (weapon.ammo, weapon.reload) == (MAGAZINE, 0)


def test_manual_reload_only_when_needed() -> None:
    full, _ = step_weapon(WeaponState(), False, True)
    assert full.reload == 0
    partial, _ = step_weapon(WeaponState(ammo=5), False, True)
    assert partial.reload == RELOAD_TICKS


def test_body_shot_damages_and_notifies_both_players() -> None:
    duel = Duel()
    duel.shoot(pitch=-0.1)
    assert duel.bob.hp == MAX_HEALTH - DAMAGE
    assert duel.alice.weapon.ammo == MAGAZINE - 1

    (hit,) = duel.events(duel.alice_conn, "hit")
    assert hit["target"] == "b2"
    assert hit["dmg"] == DAMAGE
    assert hit["head"] is False
    assert duel.events(duel.bob_conn, "hit") == [hit]
    # Bob sees the shot itself; Alice already drew her own.
    assert len(duel.events(duel.bob_conn, "shot")) == 1
    assert duel.events(duel.alice_conn, "shot") == []
    assert duel.bob_conn.last("snapshot")["status"]["hp"] == MAX_HEALTH - DAMAGE


def test_headshot_does_double_damage() -> None:
    duel = Duel()
    duel.shoot(pitch=0.02)
    assert duel.bob.hp == MAX_HEALTH - 2 * DAMAGE
    assert duel.events(duel.alice_conn, "hit")[0]["head"] is True


def test_walls_block_shots() -> None:
    duel = Duel()
    duel.bob.state = standing((0.0, 0.0, -15.0))
    duel.bob.history.clear()
    duel.shoot()
    assert duel.bob.hp == MAX_HEALTH
    assert duel.events(duel.bob_conn, "shot")[0]["to"] == pytest.approx([0, 1.6, -10])


def test_fire_rate_cannot_be_exceeded() -> None:
    duel = Duel()
    for _ in range(FIRE_INTERVAL_TICKS):
        duel.act(duel.alice, cmd(pitch=-0.1, fire=True))
    assert duel.bob.hp == MAX_HEALTH - DAMAGE


def test_kill_death_and_respawn() -> None:
    duel = Duel()
    for _ in range(MAX_HEALTH // DAMAGE):
        duel.shoot(pitch=-0.1)

    assert duel.bob.alive is False
    assert (duel.alice.kills, duel.bob.deaths) == (1, 1)
    kill = {"t": "event", "e": "kill", "by": "a1", "target": "b2", "head": False}
    assert duel.events(duel.alice_conn, "kill") == [kill]
    assert duel.events(duel.bob_conn, "kill") == [kill]
    # The dead are not drawn and cannot be hit or act.
    assert duel.alice_conn.last("snapshot")["players"] == []
    duel.shoot(pitch=-0.1)
    assert duel.bob.deaths == 1
    frozen = duel.bob.state
    duel.act(duel.bob, InputCmd(1.0, 0.0, False, False, False, math.pi, 0.0, True, False))
    assert duel.bob.state == frozen
    assert duel.alice.hp == MAX_HEALTH

    duel.wait(RESPAWN_DELAY_S)
    assert duel.bob.alive is True
    assert duel.bob.hp == MAX_HEALTH
    assert duel.bob.weapon == WeaponState()
    spawn = duel.events(duel.bob_conn, "spawn")[-1]
    assert spawn["id"] == "b2"
    # Alice stands at the origin; the farthest spawn point is the far corner.
    assert duel.bob.state.pos == (40.0, 0.0, 40.0)


def test_spawn_protection_ends_with_time_or_when_attacking() -> None:
    duel = Duel()
    duel.bob.protected_until = duel.room.time + 10
    duel.shoot(pitch=-0.1)
    assert duel.bob.hp == MAX_HEALTH

    duel.bob.state = standing((0.0, 0.0, -5.0), yaw=math.pi)
    duel.act(duel.bob, cmd(yaw=math.pi, fire=True))
    assert duel.alice.hp < MAX_HEALTH
    duel.shoot(pitch=-0.1)
    assert duel.bob.hp == MAX_HEALTH - DAMAGE


def test_lag_compensation_hits_where_the_shooter_saw_the_target() -> None:
    duel = Duel()
    seen_at = duel.room.time
    # Bob then runs out of the line of fire.
    duel.bob.state = standing((3.0, 0.0, -5.0))
    duel.wait(0.2)

    duel.act(duel.alice, cmd(pitch=-0.1, fire=True), render_time=seen_at)
    assert duel.bob.hp == MAX_HEALTH - DAMAGE


def test_lag_compensation_is_bounded() -> None:
    duel = Duel()
    seen_at = duel.room.time
    duel.bob.state = standing((3.0, 0.0, -5.0))
    duel.wait(MAX_REWIND_S + 0.3)

    # A client claiming to see the distant past is only rewound by the allowed window.
    duel.act(duel.alice, cmd(pitch=-0.1, fire=True), render_time=seen_at)
    assert duel.bob.hp == MAX_HEALTH


def test_third_player_sees_shots_and_kills() -> None:
    duel = Duel()
    carol = FakeConn()
    duel.room.join(CAROL, carol)
    duel.wait(0.1)
    for _ in range(MAX_HEALTH // DAMAGE):
        duel.shoot(pitch=-0.1)
    assert len(duel.events(carol, "shot")) == MAX_HEALTH // DAMAGE
    assert len(duel.events(carol, "kill")) == 1
    assert duel.events(carol, "hit") == []
