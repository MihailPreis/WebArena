"""Hitscan shots: rays against map geometry and player hitboxes."""

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
WEAPON_RANGE: float = CONSTANTS["weapon"]["range"]


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


def eye_position(state: PlayerState) -> Vec3:
    height = CROUCH_EYE_HEIGHT if state.crouched else STAND_EYE_HEIGHT
    return (state.pos[0], state.pos[1] + height, state.pos[2])


def aim_direction(yaw: float, pitch: float) -> Vec3:
    """Unit vector the player looks along. Yaw 0 looks along -z; positive pitch looks up."""
    horizontal = math.cos(pitch)
    return (-math.sin(yaw) * horizontal, math.sin(pitch), -math.cos(yaw) * horizontal)


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
    game_map: GameMap, origin: Vec3, direction: Vec3, targets: Sequence[Target]
) -> ShotResult:
    """Finds the first thing a shot hits. Walls stop shots; players do not shield each other
    beyond the first one hit.
    """
    nearest = WEAPON_RANGE
    for block in game_map.blocks:
        distance = ray_box(origin, direction, block.min, block.max)
        if distance is not None and distance < nearest:
            nearest = distance

    hit: Target | None = None
    for target in targets:
        x, y, z = target.pos
        top = y + (CROUCH_HEIGHT if target.crouched else STAND_HEIGHT)
        distance = ray_box(
            origin,
            direction,
            (x - HALF_WIDTH, y, z - HALF_WIDTH),
            (x + HALF_WIDTH, top, z + HALF_WIDTH),
        )
        if distance is not None and distance < nearest:
            nearest = distance
            hit = target

    end = (
        origin[0] + direction[0] * nearest,
        origin[1] + direction[1] * nearest,
        origin[2] + direction[2] * nearest,
    )
    if hit is None:
        return ShotResult(end, None, False)
    top = hit.pos[1] + (CROUCH_HEIGHT if hit.crouched else STAND_HEIGHT)
    # The head is the top slice of the hitbox, judged by where the shot enters it.
    return ShotResult(end, hit.id, end[1] >= top - HEAD_HEIGHT - 1e-9)
