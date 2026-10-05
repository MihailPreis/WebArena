import dataclasses
import math
from typing import Any

import pytest

from arena.db.players import Player
from arena.game.combat import Target, aim_direction, pellet_directions, ray_box, trace_shot
from arena.game.map import Block, GameMap, Spawn, Vec3, load_map
from arena.game.movement import InputCmd, PlayerState
from arena.game.room import (
    ARMOR_ABSORB,
    KNOCKBACK,
    MAX_ARMOR,
    MAX_HEALTH,
    MAX_REWIND_S,
    QUAD_MULTIPLIER,
    QUAD_S,
    RESPAWN_DELAY_S,
    SELF_DAMAGE,
    SNAPSHOT_INTERVAL,
    SPAWN_PROTECTION_S,
    SPLASH_RADIUS,
    MatchSettings,
    Member,
    Room,
)
from arena.game.weapon import (
    SWITCH_TICKS,
    WEAPONS,
    WeaponState,
    give_ammo,
    give_weapon,
    step_weapon,
)
from tests.conftest import FakeConn

ARENA = load_map("arena")
ALICE = Player("a1", "Alice", "#ff5555")
BOB = Player("b2", "Bob", "#54a0ff")
CAROL = Player("c3", "Carol", "#2ed573")

MACHINEGUN, SHOTGUN, ROCKETS, RAILGUN = range(4)
DAMAGE = WEAPONS[MACHINEGUN].damage
SHOTS_TO_KILL = math.ceil(MAX_HEALTH / DAMAGE)
# Every weapon in hand, with its box of ammunition.
ARSENAL = WeaponState()
for _index in (SHOTGUN, ROCKETS, RAILGUN):
    ARSENAL = give_weapon(ARSENAL, _index) or ARSENAL

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


def cmd(yaw: float = 0.0, pitch: float = 0.0, fire: bool = False, weapon: int = 0) -> InputCmd:
    return InputCmd(0.0, 0.0, False, False, False, yaw, pitch, fire, weapon)


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
        for _ in range(WEAPONS[MACHINEGUN].interval_ticks):
            self.act(self.alice, cmd(yaw, pitch))

    def arm(self, member: Member, weapon: int) -> None:
        """Puts the given weapon, loaded, into the player's hands."""
        member.weapon = dataclasses.replace(ARSENAL, current=weapon)

    def events(self, conn: FakeConn, kind: str) -> list[dict[str, Any]]:
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


def test_weapon_fire_rate_and_ammunition() -> None:
    weapon = WeaponState()
    interval = WEAPONS[MACHINEGUN].interval_ticks
    shots = 0
    for _ in range(interval * 3):
        weapon, fired = step_weapon(weapon, True, MACHINEGUN)
        shots += fired
    assert shots == 3
    assert weapon.ammo[MACHINEGUN] == WEAPONS[MACHINEGUN].start_ammo - 3

    # There is no reloading: an empty weapon just stops.
    empty = dataclasses.replace(weapon, ammo=(0, 0, 0, 0), cooldown=0)
    assert step_weapon(empty, True, MACHINEGUN) == (empty, False)


def test_weapon_switch_takes_time_and_needs_the_weapon() -> None:
    # A weapon that was never picked up cannot be chosen.
    bare, _ = step_weapon(WeaponState(), False, RAILGUN)
    assert bare.current == MACHINEGUN

    weapon, fired = step_weapon(ARSENAL, True, RAILGUN)
    assert (weapon.current, fired) == (RAILGUN, False)
    for _ in range(SWITCH_TICKS - 1):
        weapon, fired = step_weapon(weapon, True, RAILGUN)
        assert not fired
    weapon, fired = step_weapon(weapon, True, RAILGUN)
    assert fired
    assert weapon.ammo[RAILGUN] == WEAPONS[RAILGUN].pickup_ammo - 1


def test_empty_weapon_falls_back_to_the_best_loaded_one() -> None:
    weapon = dataclasses.replace(ARSENAL, current=RAILGUN, ammo=(50, 5, 0, 1))
    weapon, fired = step_weapon(weapon, True, RAILGUN)
    assert fired
    weapon, _ = step_weapon(weapon, True, RAILGUN)
    assert weapon.current == SHOTGUN
    # Asking for an empty weapon changes nothing.
    weapon, _ = step_weapon(weapon, False, ROCKETS)
    assert weapon.current == SHOTGUN


def test_picking_up_weapons_and_ammunition() -> None:
    weapon = give_weapon(WeaponState(), SHOTGUN)
    assert weapon is not None
    assert weapon.owned == 0b11
    assert weapon.ammo[SHOTGUN] == WEAPONS[SHOTGUN].pickup_ammo
    full = dataclasses.replace(weapon, ammo=tuple(spec.max_ammo for spec in WEAPONS))
    assert give_ammo(full, SHOTGUN) is None
    assert give_weapon(full, SHOTGUN) is None
    # A new weapon is worth taking even when its ammunition is already full.
    assert give_weapon(full, RAILGUN) is not None


def test_pellets_fan_out_around_the_aim() -> None:
    spec = WEAPONS[SHOTGUN]
    pellets = pellet_directions(0.3, -0.2, spec.pellets, spec.spread)
    forward = aim_direction(0.3, -0.2)
    assert len(pellets) == spec.pellets
    assert pellets[0] == forward
    # The same numbers are pinned in client/src/game/sim/combat.test.ts.
    assert pellets[1][0] == pytest.approx(-0.2636249628, abs=1e-9)
    assert pellets[10][1] == pytest.approx(-0.1981843724, abs=1e-9)
    for pellet in pellets[1:]:
        assert math.hypot(*pellet) == pytest.approx(1)
        cosine = sum(a * b for a, b in zip(pellet, forward, strict=True))
        assert math.tan(math.acos(cosine)) <= spec.spread + 1e-9
    centre = [sum(p[axis] for p in pellets) for axis in range(3)]
    length = math.hypot(*centre)
    assert [c / length for c in centre] == pytest.approx(forward, abs=1e-6)


def test_body_shot_damages_and_notifies_both_players() -> None:
    duel = Duel()
    duel.shoot(pitch=-0.1)
    assert duel.bob.hp == MAX_HEALTH - DAMAGE
    assert duel.alice.weapon.ammo[MACHINEGUN] == WEAPONS[MACHINEGUN].start_ammo - 1

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
    assert duel.alice.headshots == 1
    assert duel.events(duel.alice_conn, "hit")[0]["head"] is True


def test_walls_block_shots() -> None:
    duel = Duel()
    duel.bob.state = standing((0.0, 0.0, -15.0))
    duel.bob.history.clear()
    duel.shoot()
    assert duel.bob.hp == MAX_HEALTH
    shot = duel.events(duel.bob_conn, "shot")[0]
    assert shot["w"] == MACHINEGUN
    assert shot["to"] == [pytest.approx([0, 1.6, -10])]


def test_fire_rate_cannot_be_exceeded() -> None:
    duel = Duel()
    for _ in range(WEAPONS[MACHINEGUN].interval_ticks):
        duel.act(duel.alice, cmd(pitch=-0.1, fire=True))
    assert duel.bob.hp == MAX_HEALTH - DAMAGE


def test_kill_death_and_respawn() -> None:
    duel = Duel()
    for _ in range(SHOTS_TO_KILL):
        duel.shoot(pitch=-0.1)

    assert duel.bob.alive is False
    assert (duel.alice.kills, duel.bob.deaths) == (1, 1)
    kill = {"t": "event", "e": "kill", "by": "a1", "target": "b2", "head": False, "fall": False}
    assert duel.events(duel.alice_conn, "kill") == [kill]
    assert duel.events(duel.bob_conn, "kill") == [kill]
    # The dead are not drawn and cannot be hit or act.
    assert duel.alice_conn.last("snapshot")["players"] == []
    duel.shoot(pitch=-0.1)
    assert duel.bob.deaths == 1
    frozen = duel.bob.state
    duel.act(duel.bob, InputCmd(1.0, 0.0, False, False, False, math.pi, 0.0, True))
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
    for _ in range(SHOTS_TO_KILL):
        duel.shoot(pitch=-0.1)
    assert len(duel.events(carol, "shot")) == SHOTS_TO_KILL
    assert len(duel.events(carol, "kill")) == 1
    assert duel.events(carol, "hit") == []


def test_shotgun_pellets_add_up_to_one_hit() -> None:
    duel = Duel()
    duel.arm(duel.alice, SHOTGUN)
    duel.bob.state = standing((0.0, 0.0, -2.0))
    duel.bob.history.clear()
    duel.act(duel.alice, cmd(pitch=-0.3, fire=True, weapon=SHOTGUN))

    spec = WEAPONS[SHOTGUN]
    (hit,) = duel.events(duel.alice_conn, "hit")
    assert hit["dmg"] == spec.pellets * spec.damage
    assert hit["head"] is False
    assert duel.bob.alive is False
    assert (duel.alice.shots, duel.alice.hits) == (1, 1)
    (shot,) = duel.events(duel.bob_conn, "shot")
    assert shot["w"] == SHOTGUN
    assert len(shot["to"]) == spec.pellets


def test_armor_takes_its_share_of_the_damage() -> None:
    duel = Duel()
    duel.bob.armor = 50
    duel.shoot(pitch=-0.1)
    absorbed = math.ceil(DAMAGE * ARMOR_ABSORB)
    assert duel.bob.armor == 50 - absorbed
    assert duel.bob.hp == MAX_HEALTH - (DAMAGE - absorbed)
    assert duel.alice.damage_dealt == duel.bob.damage_taken == DAMAGE
    status = duel.bob_conn.last("snapshot")["status"]
    assert (status["hp"], status["armor"]) == (duel.bob.hp, duel.bob.armor)

    # Armour that runs out leaves the rest to health.
    duel.bob.armor = 1
    duel.shoot(pitch=-0.1)
    assert duel.bob.armor == 0
    assert duel.bob.hp == MAX_HEALTH - (DAMAGE - absorbed) - (DAMAGE - 1)


def test_quad_multiplies_damage_until_it_runs_out() -> None:
    duel = Duel()
    duel.alice.quad_until = duel.room.time + QUAD_S
    duel.shoot(pitch=-0.1)
    assert duel.bob.hp == MAX_HEALTH - DAMAGE * QUAD_MULTIPLIER
    assert duel.bob_conn.last("snapshot")["players"][0]["quad"] is True
    assert 0 < duel.alice_conn.last("snapshot")["status"]["quad"] <= QUAD_S

    duel.bob.hp = MAX_HEALTH
    duel.wait(QUAD_S)
    duel.shoot(pitch=-0.1)
    assert duel.bob.hp == MAX_HEALTH - DAMAGE
    assert duel.alice_conn.last("snapshot")["status"]["quad"] == 0


def test_rocket_flies_and_kills_on_a_direct_hit() -> None:
    duel = Duel()
    duel.arm(duel.alice, ROCKETS)
    duel.act(duel.alice, cmd(pitch=-0.1, fire=True, weapon=ROCKETS))

    launch = {"t": "event", "e": "rocket", "n": 1, "id": "a1"}
    for conn in (duel.alice_conn, duel.bob_conn):
        (event,) = duel.events(conn, "rocket")
        assert event["from"] == [0, 1.6, 0]
        assert {key: event[key] for key in launch} == launch
    # It takes a moment to cover five metres.
    assert duel.bob.hp == MAX_HEALTH
    assert duel.events(duel.bob_conn, "shot") == []
    duel.wait(0.3)

    assert duel.bob.alive is False
    assert duel.room.rockets == []
    (blast,) = duel.events(duel.bob_conn, "explode")
    assert blast["n"] == 1
    assert blast["pos"][2] == pytest.approx(-5 + 0.35)
    assert (duel.alice.kills, duel.alice.shots, duel.alice.hits) == (1, 1, 1)
    assert duel.alice.hp == MAX_HEALTH  # Too far away to be caught by her own blast.


def test_rocket_blast_fades_with_distance_and_stops_at_walls() -> None:
    duel = Duel()
    duel.arm(duel.alice, ROCKETS)
    # The rocket lands on the floor two metres to Bob's side; Carol is behind the wall.
    carol = duel.room.join(CAROL, FakeConn())
    duel.wait(SPAWN_PROTECTION_S + 0.1)
    carol.state = standing((2.35, 0.0, -11.5))
    duel.bob.state = standing((0.0, 0.0, -9.0))
    target = (2.35, 0.0, -9.0)
    yaw = math.atan2(-target[0], -target[2])
    pitch = math.atan2(-1.6, math.hypot(target[0], target[2]))
    duel.act(duel.alice, cmd(yaw, pitch, fire=True, weapon=ROCKETS))
    duel.wait(0.6)

    (blast,) = duel.events(duel.bob_conn, "explode")
    assert blast["pos"] == pytest.approx(list(target), abs=1e-6)
    assert MAX_HEALTH - duel.bob.hp == round(WEAPONS[ROCKETS].damage * (1 - 2 / SPLASH_RADIUS))
    # The blast throws him away from where it went off.
    assert duel.bob.state.vel[0] < 0
    assert carol.hp == MAX_HEALTH


def test_rocket_jump_hurts_and_lifts_the_shooter() -> None:
    duel = Duel()
    duel.arm(duel.alice, ROCKETS)
    duel.act(duel.alice, cmd(pitch=-1.5, fire=True, weapon=ROCKETS))
    duel.wait(0.1)  # The rocket has to reach the floor.

    spec = WEAPONS[ROCKETS]
    assert duel.alice.hp == MAX_HEALTH - round(spec.damage * SELF_DAMAGE)
    assert duel.alice.state.vel[1] == pytest.approx(spec.damage * KNOCKBACK, rel=0.05)
    assert duel.alice.hits == 0
    duel.act(duel.alice, cmd())
    assert duel.alice.state.pos[1] > 0


def test_blowing_yourself_up_is_a_death_without_a_kill() -> None:
    duel = Duel()
    duel.arm(duel.alice, ROCKETS)
    duel.alice.hp = 10
    duel.act(duel.alice, cmd(pitch=-1.5, fire=True, weapon=ROCKETS))
    duel.wait(0.1)
    assert duel.alice.alive is False
    assert (duel.alice.kills, duel.alice.deaths) == (0, 1)
    kill = {"t": "event", "e": "kill", "by": "a1", "target": "a1", "head": False, "fall": False}
    assert duel.events(duel.bob_conn, "kill") == [kill]


def test_respawn_takes_away_weapons_armor_and_quad() -> None:
    duel = Duel()
    duel.arm(duel.bob, RAILGUN)
    duel.bob.quad_until = duel.room.time + QUAD_S
    duel.bob.hp = 1
    duel.shoot(pitch=-0.1)
    duel.bob.armor = MAX_ARMOR
    duel.wait(RESPAWN_DELAY_S)
    assert duel.bob.alive is True
    assert (duel.bob.weapon, duel.bob.armor, duel.bob.quad_until) == (WeaponState(), 0, 0.0)
