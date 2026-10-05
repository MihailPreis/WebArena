"""Every map that can be played must hold together: nothing inside walls, nothing
over the void, and every jump pad and teleporter leading somewhere.
"""

import math

import pytest

from arena.game.collision import overlaps_any
from arena.game.map import GameMap, Spawn, Vec3, load_map
from arena.game.movement import (
    CROUCH_HEIGHT,
    HALF_WIDTH,
    STAND_HEIGHT,
    TICK_DT,
    InputCmd,
    PlayerState,
    create_player,
    step_player,
)
from arena.game.room import TELEPORT_DISTANCE
from arena.shared import DEV_MAPS, MAPS

IDLE = InputCmd(0.0, 0.0, False, False, False, 0.0, 0.0)
ALL = [load_map(name) for name in (*MAPS, *DEV_MAPS)]
maps = pytest.mark.parametrize("game_map", ALL, ids=lambda game_map: game_map.name)


def fits(game_map: GameMap, pos: Vec3, height: float = STAND_HEIGHT) -> bool:
    """A player of the given height fits at `pos` without touching a block."""
    x, y, z = pos
    lo = (x - HALF_WIDTH, y + 0.01, z - HALF_WIDTH)
    hi = (x + HALF_WIDTH, y + height, z + HALF_WIDTH)
    return not overlaps_any(game_map.blocks, lo, hi)


def has_floor(game_map: GameMap, pos: Vec3) -> bool:
    x, y, z = pos
    return overlaps_any(
        game_map.blocks, (x - 0.01, y - 0.1, z - 0.01), (x + 0.01, y - 0.01, z + 0.01)
    )


def settle(game_map: GameMap, state: PlayerState, seconds: float = 4.0) -> PlayerState:
    """Lets a player who does nothing fly and fall until they stand still."""
    for _ in range(round(seconds / TICK_DT)):
        state = step_player(state, IDLE, game_map, TICK_DT)
        if state.pos[1] < game_map.kill_y:
            break
        if state.on_ground and math.hypot(*state.vel) < 0.01:
            break
    return state


def in_trigger(game_map: GameMap, pos: Vec3) -> bool:
    """A player standing at `pos` touches a jump pad or a teleporter."""
    lo = (pos[0] - HALF_WIDTH, pos[1], pos[2] - HALF_WIDTH)
    hi = (pos[0] + HALF_WIDTH, pos[1] + STAND_HEIGHT, pos[2] + HALF_WIDTH)
    boxes = [(pad.min, pad.max) for pad in game_map.pads]
    boxes += [(gate.min, gate.max) for gate in game_map.teleporters]
    return any(
        all(lo[axis] < box_max[axis] and hi[axis] > box_min[axis] for axis in range(3))
        for box_min, box_max in boxes
    )


@maps
def test_name_matches_the_file(game_map: GameMap) -> None:
    assert load_map(game_map.name) is game_map


@maps
def test_spawns_are_safe_places_to_stand(game_map: GameMap) -> None:
    assert len(game_map.spawns) >= 8
    for spawn in game_map.spawns:
        assert fits(game_map, spawn.position), spawn
        assert has_floor(game_map, spawn.position), spawn
        assert not in_trigger(game_map, spawn.position), spawn
        rested = settle(game_map, create_player(spawn), 1.0)
        assert math.dist(rested.pos, spawn.position) < 0.01, spawn


@maps
def test_items_can_be_reached(game_map: GameMap) -> None:
    kinds = {item.type for item in game_map.items}
    assert {"shotgun", "rocketlauncher", "railgun", "quad", "health", "armor"} <= kinds
    for item in game_map.items:
        # Some lie in low places that are entered crouching.
        assert fits(game_map, item.position, CROUCH_HEIGHT), item
        assert has_floor(game_map, item.position), item
        assert not in_trigger(game_map, item.position), item


@maps
def test_jump_pads_land_on_solid_ground_elsewhere(game_map: GameMap) -> None:
    for pad in game_map.pads:
        start = ((pad.min[0] + pad.max[0]) / 2, pad.min[1], (pad.min[2] + pad.max[2]) / 2)
        assert has_floor(game_map, start), pad
        landed = settle(game_map, create_player(Spawn(start, 0.0)))
        assert landed.on_ground, pad
        assert landed.pos[1] > game_map.kill_y, pad
        assert math.dist(landed.pos, start) > 3, pad
        assert not in_trigger(game_map, landed.pos), pad


@maps
def test_teleporters_lead_to_open_ground_far_away(game_map: GameMap) -> None:
    for gate in game_map.teleporters:
        assert fits(game_map, gate.to), gate
        assert has_floor(game_map, gate.to), gate
        assert not in_trigger(game_map, gate.to), gate
        centre = tuple((gate.min[a] + gate.max[a]) / 2 for a in range(3))
        # Far enough for clients and lag compensation to treat it as a jump, not a run.
        assert math.dist(centre, gate.to) > 2 * TELEPORT_DISTANCE, gate
        assert has_floor(game_map, (centre[0], gate.min[1], centre[2])), gate
        # Stepping into the gate really moves the player there.
        inside = PlayerState(
            (centre[0], gate.min[1], centre[2]), (0.0, 0.0, 0.0), 0.0, 0.0, True, False, False
        )
        assert step_player(inside, IDLE, game_map, TICK_DT).pos == gate.to


def turned(pos: Vec3) -> Vec3:
    """The same point on the other side: half a circle about the centre. `+ 0.0` drops -0.0."""
    return (round(-pos[0], 6) + 0.0, round(pos[1], 6), round(-pos[2], 6) + 0.0)


def same(pos: Vec3) -> Vec3:
    return (round(pos[0], 6) + 0.0, round(pos[1], 6), round(pos[2], 6) + 0.0)


@pytest.mark.parametrize("name", MAPS)
def test_playable_maps_are_the_same_for_both_teams(name: str) -> None:
    game_map = load_map(name)
    spawns = {same(spawn.position) for spawn in game_map.spawns}
    assert {turned(pos) for pos in spawns} == spawns
    items = {(item.type, same(item.position)) for item in game_map.items}
    assert {(kind, turned(pos)) for kind, pos in items} == items
    # A block turned half a circle swaps its corners.
    blocks = {(same(block.min), same(block.max)) for block in game_map.blocks}
    mirrored = set()
    for lo, hi in blocks:
        a, b = turned(lo), turned(hi)
        mirrored.add(((b[0], a[1], b[2]), (a[0], b[1], a[2])))
    assert mirrored == blocks
