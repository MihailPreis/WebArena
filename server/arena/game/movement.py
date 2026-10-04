"""Mirror of client/src/game/sim/movement.ts.

The client predicts its own movement with the same algorithm, so every change
here must be made there too and checked against shared/movement_vectors.json.
Keep the order of floating-point operations identical.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

from arena.game.collision import overlaps_any, sweep_axis
from arena.game.map import Block, GameMap, Spawn, Vec3
from arena.shared import CONSTANTS

_PLAYER = CONSTANTS["player"]
_MOVEMENT = CONSTANTS["movement"]

TICK_DT: float = 1 / CONSTANTS["tickRate"]

HALF_WIDTH: float = _PLAYER["halfWidth"]
STAND_HEIGHT: float = _PLAYER["standHeight"]
CROUCH_HEIGHT: float = _PLAYER["crouchHeight"]
STEP_HEIGHT: float = _PLAYER["stepHeight"]

RUN_SPEED: float = _MOVEMENT["runSpeed"]
SPRINT_SPEED: float = _MOVEMENT["sprintSpeed"]
CROUCH_SPEED: float = _MOVEMENT["crouchSpeed"]
GROUND_ACCEL: float = _MOVEMENT["groundAccel"]
AIR_ACCEL: float = _MOVEMENT["airAccel"]
FRICTION: float = _MOVEMENT["friction"]
STOP_SPEED: float = _MOVEMENT["stopSpeed"]
GRAVITY: float = _MOVEMENT["gravity"]
JUMP_SPEED: float = _MOVEMENT["jumpSpeed"]


@dataclass(frozen=True)
class PlayerState:
    pos: Vec3
    """Centre of the bounding box footprint, at feet level."""
    vel: Vec3
    yaw: float
    pitch: float
    on_ground: bool
    crouched: bool
    jump_held: bool
    """Jump was held on the previous tick; a new jump needs a fresh press."""


@dataclass(frozen=True)
class InputCmd:
    forward: float
    right: float
    jump: bool
    crouch: bool
    sprint: bool
    yaw: float
    pitch: float
    # Not used by movement; carried here so one input describes everything the player did.
    fire: bool = False
    reload: bool = False


def create_player(spawn: Spawn) -> PlayerState:
    return PlayerState(
        pos=spawn.position,
        vel=(0.0, 0.0, 0.0),
        yaw=spawn.yaw,
        pitch=0.0,
        on_ground=False,
        crouched=False,
        jump_held=False,
    )


def _bounds(pos: Sequence[float], height: float) -> tuple[list[float], list[float]]:
    r = HALF_WIDTH
    return (
        [pos[0] - r, pos[1], pos[2] - r],
        [pos[0] + r, pos[1] + height, pos[2] + r],
    )


def _clamp(value: float, lo: float, hi: float) -> float:
    return min(max(value, lo), hi)


def _apply_friction(vel: list[float], dt: float) -> None:
    speed = math.sqrt(vel[0] * vel[0] + vel[2] * vel[2])
    if speed < 1e-4:
        vel[0] = 0.0
        vel[2] = 0.0
        return
    drop = max(speed, STOP_SPEED) * FRICTION * dt
    scale = max(speed - drop, 0.0) / speed
    vel[0] *= scale
    vel[2] *= scale


def _accelerate(
    vel: list[float], wish_x: float, wish_z: float, wish_speed: float, accel: float, dt: float
) -> None:
    add_speed = wish_speed - (vel[0] * wish_x + vel[2] * wish_z)
    if add_speed <= 0:
        return
    accel_speed = min(accel * wish_speed * dt, add_speed)
    vel[0] += accel_speed * wish_x
    vel[2] += accel_speed * wish_z


def _move_horizontal(
    blocks: Sequence[Block], start: Sequence[float], height: float, dx: float, dz: float
) -> tuple[list[float], bool, bool]:
    pos = list(start)
    lo, hi = _bounds(pos, height)
    moved_x = sweep_axis(blocks, lo, hi, 0, dx)
    pos[0] += moved_x
    lo, hi = _bounds(pos, height)
    moved_z = sweep_axis(blocks, lo, hi, 2, dz)
    pos[2] += moved_z
    return pos, moved_x != dx, moved_z != dz


def _move_with_step(
    blocks: Sequence[Block], start: Sequence[float], height: float, dx: float, dz: float
) -> tuple[list[float], bool, bool]:
    """Retries a blocked horizontal move from one step height up, then settles back down."""
    lo, hi = _bounds(start, height)
    up = sweep_axis(blocks, lo, hi, 1, STEP_HEIGHT)
    pos, hit_x, hit_z = _move_horizontal(
        blocks, [start[0], start[1] + up, start[2]], height, dx, dz
    )
    lo, hi = _bounds(pos, height)
    pos[1] += sweep_axis(blocks, lo, hi, 1, -up)
    return pos, hit_x, hit_z


def _travelled(start: Sequence[float], end: Sequence[float]) -> float:
    dx = end[0] - start[0]
    dz = end[2] - start[2]
    return math.sqrt(dx * dx + dz * dz)


def step_player(prev: PlayerState, cmd: InputCmd, game_map: GameMap, dt: float) -> PlayerState:
    """Advances the player by one fixed tick. Pure: returns a new state."""
    blocks = game_map.blocks
    pos = list(prev.pos)
    vel = list(prev.vel)

    crouched = prev.crouched
    if cmd.crouch:
        crouched = True
    elif crouched:
        lo, hi = _bounds(pos, STAND_HEIGHT)
        if not overlaps_any(blocks, lo, hi):
            crouched = False
    height = CROUCH_HEIGHT if crouched else STAND_HEIGHT

    forward = _clamp(cmd.forward, -1.0, 1.0)
    right = _clamp(cmd.right, -1.0, 1.0)
    sin = math.sin(cmd.yaw)
    cos = math.cos(cmd.yaw)
    wish_x = -sin * forward + cos * right
    wish_z = -cos * forward - sin * right
    wish_length = math.sqrt(wish_x * wish_x + wish_z * wish_z)
    if wish_length > 0:
        wish_x /= wish_length
        wish_z /= wish_length
    max_speed = RUN_SPEED
    if crouched:
        max_speed = CROUCH_SPEED
    elif cmd.sprint:
        max_speed = SPRINT_SPEED
    wish_speed = max_speed * min(wish_length, 1.0)

    jumped = prev.on_ground and cmd.jump and not prev.jump_held
    grounded = prev.on_ground and not jumped
    if jumped:
        vel[1] = JUMP_SPEED
    if grounded:
        _apply_friction(vel, dt)
        _accelerate(vel, wish_x, wish_z, wish_speed, GROUND_ACCEL, dt)
    else:
        _accelerate(vel, wish_x, wish_z, wish_speed, AIR_ACCEL, dt)
    vel[1] -= GRAVITY * dt

    dx = vel[0] * dt
    dz = vel[2] * dt
    new_pos, hit_x, hit_z = _move_horizontal(blocks, pos, height, dx, dz)
    if grounded and (hit_x or hit_z):
        stepped = _move_with_step(blocks, pos, height, dx, dz)
        if _travelled(pos, stepped[0]) > _travelled(pos, new_pos) + 1e-6:
            new_pos, hit_x, hit_z = stepped
    pos = new_pos
    if hit_x:
        vel[0] = 0.0
    if hit_z:
        vel[2] = 0.0

    on_ground = False
    dy = vel[1] * dt
    lo, hi = _bounds(pos, height)
    moved_y = sweep_axis(blocks, lo, hi, 1, dy)
    pos[1] += moved_y
    if moved_y != dy:
        on_ground = dy < 0
        vel[1] = 0.0

    # Keep contact with the ground when walking down stairs instead of hopping off each step.
    if grounded and not on_ground:
        lo, hi = _bounds(pos, height)
        drop = sweep_axis(blocks, lo, hi, 1, -STEP_HEIGHT)
        if drop != -STEP_HEIGHT:
            pos[1] += drop
            vel[1] = 0.0
            on_ground = True

    return PlayerState(
        pos=(pos[0], pos[1], pos[2]),
        vel=(vel[0], vel[1], vel[2]),
        yaw=cmd.yaw,
        pitch=cmd.pitch,
        on_ground=on_ground,
        crouched=crouched,
        jump_held=cmd.jump,
    )
