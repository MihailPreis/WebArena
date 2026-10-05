"""Shots and blasts: rays against map geometry and player hitboxes."""

import math
from collections.abc import Sequence
from dataclasses import dataclass

from arena.game.map import GameMap, Vec3
from arena.game.movement import CROUCH_HEIGHT, HALF_WIDTH, STAND_HEIGHT, PlayerState
from arena.shared import CONSTANTS

_PLAYER = CONSTANTS["player"]
STAND_EYE_HEIGHT: float = _PLAYER["standEyeHeight"]
CROUCH_EYE_HEIGHT: float = _PLAYER["crouchEyeHeight"]
HEAD_HEIGHT: float = CONSTANTS["combat"]["headHeight"]
WEAPON_RANGE: float = CONSTANTS["combat"]["range"]


@dataclass(frozen=True)
class Target:
    id: str
    pos: Vec3
    """Feet position."""
    crouched: bool


@dataclass(frozen=True)
class ShotResult:
    end: Vec3
    """Where the shot stopped: on a player, on a wall, or at maximum range."""
    target_id: str | None
    head: bool
    distance: float = 0.0
    """How far the shot travelled."""


def eye_position(state: PlayerState) -> Vec3:
    height = CROUCH_EYE_HEIGHT if state.crouched else STAND_EYE_HEIGHT
    return (state.pos[0], state.pos[1] + height, state.pos[2])


def aim_direction(yaw: float, pitch: float) -> Vec3:
    """Unit vector the player looks along. Yaw 0 looks along -z; positive pitch looks up."""
    horizontal = math.cos(pitch)
    return (-math.sin(yaw) * horizontal, math.sin(pitch), -math.cos(yaw) * horizontal)


def pellet_directions(yaw: float, pitch: float, pellets: int, spread: float) -> list[Vec3]:
    """Where each pellet of a shot flies. The pattern is fixed, not random: one pellet
    along the aim and the rest on two rings around it, so the client can draw the same.
    Mirrors `pelletDirections` in client/src/game/sim/ray.ts.
    """
    forward = aim_direction(yaw, pitch)
    if pellets <= 1:
        return [forward]
    sin_yaw = math.sin(yaw)
    cos_yaw = math.cos(yaw)
    right = (cos_yaw, 0.0, -sin_yaw)
    up = (sin_yaw * forward[1], -sin_yaw * forward[0] - cos_yaw * forward[2], cos_yaw * forward[1])
    directions = [forward]
    for i in range(1, pellets):
        radius = spread * (0.5 if i % 2 == 1 else 1.0)
        angle = 2 * math.pi * i / (pellets - 1)
        a = math.cos(angle) * radius
        b = math.sin(angle) * radius
        x = forward[0] + right[0] * a + up[0] * b
        y = forward[1] + right[1] * a + up[1] * b
        z = forward[2] + right[2] * a + up[2] * b
        length = math.sqrt(x * x + y * y + z * z)
        directions.append((x / length, y / length, z / length))
    return directions


def player_box(pos: Vec3, crouched: bool) -> tuple[Vec3, Vec3]:
    """Corners of a player's hitbox; `pos` is the feet position."""
    x, y, z = pos
    top = y + (CROUCH_HEIGHT if crouched else STAND_HEIGHT)
    return (x - HALF_WIDTH, y, z - HALF_WIDTH), (x + HALF_WIDTH, top, z + HALF_WIDTH)


def box_distance(point: Vec3, lo: Vec3, hi: Vec3) -> float:
    """Distance from a point to the nearest point of a box; 0 inside it."""
    return math.sqrt(
        sum(max(lo[axis] - point[axis], 0.0, point[axis] - hi[axis]) ** 2 for axis in range(3))
    )


def is_clear(game_map: GameMap, start: Vec3, end: Vec3) -> bool:
    """Whether nothing of the map stands between two points."""
    length = math.dist(start, end)
    if length == 0:
        return True
    direction = (
        (end[0] - start[0]) / length,
        (end[1] - start[1]) / length,
        (end[2] - start[2]) / length,
    )
    for block in game_map.blocks:
        distance = ray_box(start, direction, block.min, block.max)
        if distance is not None and distance < length:
            return False
    return True


def ray_box(
    origin: Sequence[float], direction: Sequence[float], lo: Sequence[float], hi: Sequence[float]
) -> float | None:
    """Distance along the ray to where it enters the box, or None if it misses.

    Returns 0 when the ray starts inside the box.
    """
    t_near = 0.0
    t_far = math.inf
    for axis in range(3):
        d = direction[axis]
        if d == 0:
            if origin[axis] < lo[axis] or origin[axis] > hi[axis]:
                return None
            continue
        t1 = (lo[axis] - origin[axis]) / d
        t2 = (hi[axis] - origin[axis]) / d
        if t1 > t2:
            t1, t2 = t2, t1
        t_near = max(t_near, t1)
        t_far = min(t_far, t2)
        if t_near > t_far:
            return None
    return t_near


def trace_shot(
    game_map: GameMap,
    origin: Vec3,
    direction: Vec3,
    targets: Sequence[Target],
    limit: float = WEAPON_RANGE,
) -> ShotResult:
    """Finds the first thing a shot hits within `limit` metres. Walls stop shots; players
    do not shield each other beyond the first one hit.
    """
    nearest = limit
    for block in game_map.blocks:
        distance = ray_box(origin, direction, block.min, block.max)
        if distance is not None and distance < nearest:
            nearest = distance

    hit: Target | None = None
    for target in targets:
        lo, hi = player_box(target.pos, target.crouched)
        distance = ray_box(origin, direction, lo, hi)
        if distance is not None and distance < nearest:
            nearest = distance
            hit = target

    end = (
        origin[0] + direction[0] * nearest,
        origin[1] + direction[1] * nearest,
        origin[2] + direction[2] * nearest,
    )
    if hit is None:
        return ShotResult(end, None, False, nearest)
    top = hit.pos[1] + (CROUCH_HEIGHT if hit.crouched else STAND_HEIGHT)
    # The head is the top slice of the hitbox, judged by where the shot enters it.
    return ShotResult(end, hit.id, end[1] >= top - HEAD_HEIGHT - 1e-9, nearest)
