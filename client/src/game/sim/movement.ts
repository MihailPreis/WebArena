import { overlapsAny, sweepAxis } from './collision';
import { MOVEMENT, PLAYER } from './constants';
import type { Block, GameMap, Spawn, Vec3 } from './map';

export interface PlayerState {
  /** Centre of the bounding box footprint, at feet level. */
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  crouched: boolean;
  /** Jump was held on the previous tick; a new jump needs a fresh press. */
  jumpHeld: boolean;
}

export interface InputCmd {
  /** -1..1, positive is forward. */
  forward: number;
  /** -1..1, positive is right. */
  right: number;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  yaw: number;
  pitch: number;
}

export function createPlayer(spawn: Spawn): PlayerState {
  return {
    pos: [...spawn.position],
    vel: [0, 0, 0],
    yaw: spawn.yaw,
    pitch: 0,
    onGround: false,
    crouched: false,
    jumpHeld: false,
  };
}

export function playerHeight(crouched: boolean): number {
  return crouched ? PLAYER.crouchHeight : PLAYER.standHeight;
}

export function eyeHeight(crouched: boolean): number {
  return crouched ? PLAYER.crouchEyeHeight : PLAYER.standEyeHeight;
}

function bounds(pos: Vec3, height: number): [Vec3, Vec3] {
  const r = PLAYER.halfWidth;
  return [
    [pos[0] - r, pos[1], pos[2] - r],
    [pos[0] + r, pos[1] + height, pos[2] + r],
  ];
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

function applyFriction(vel: Vec3, dt: number): void {
  const speed = Math.hypot(vel[0], vel[2]);
  if (speed < 1e-4) {
    vel[0] = 0;
    vel[2] = 0;
    return;
  }
  const drop = Math.max(speed, MOVEMENT.stopSpeed) * MOVEMENT.friction * dt;
  const scale = Math.max(speed - drop, 0) / speed;
  vel[0] *= scale;
  vel[2] *= scale;
}

function accelerate(
  vel: Vec3,
  wishX: number,
  wishZ: number,
  wishSpeed: number,
  accel: number,
  dt: number,
): void {
  const addSpeed = wishSpeed - (vel[0] * wishX + vel[2] * wishZ);
  if (addSpeed <= 0) return;
  const accelSpeed = Math.min(accel * wishSpeed * dt, addSpeed);
  vel[0] += accelSpeed * wishX;
  vel[2] += accelSpeed * wishZ;
}

interface HorizontalMove {
  pos: Vec3;
  hitX: boolean;
  hitZ: boolean;
}

function moveHorizontal(
  blocks: readonly Block[],
  from: Vec3,
  height: number,
  dx: number,
  dz: number,
): HorizontalMove {
  const pos: Vec3 = [...from];
  let [min, max] = bounds(pos, height);
  const movedX = sweepAxis(blocks, min, max, 0, dx);
  pos[0] += movedX;
  [min, max] = bounds(pos, height);
  const movedZ = sweepAxis(blocks, min, max, 2, dz);
  pos[2] += movedZ;
  return { pos, hitX: movedX !== dx, hitZ: movedZ !== dz };
}

/** Retries a blocked horizontal move from one step height up, then settles back down. */
function moveWithStep(
  blocks: readonly Block[],
  from: Vec3,
  height: number,
  dx: number,
  dz: number,
): HorizontalMove {
  let [min, max] = bounds(from, height);
  const up = sweepAxis(blocks, min, max, 1, PLAYER.stepHeight);
  const raised = moveHorizontal(blocks, [from[0], from[1] + up, from[2]], height, dx, dz);
  [min, max] = bounds(raised.pos, height);
  raised.pos[1] += sweepAxis(blocks, min, max, 1, -up);
  return raised;
}

function travelled(from: Vec3, to: Vec3): number {
  return Math.hypot(to[0] - from[0], to[2] - from[2]);
}

/** Advances the player by one fixed tick. Pure: returns a new state. */
export function stepPlayer(
  prev: PlayerState,
  cmd: InputCmd,
  map: GameMap,
  dt: number,
): PlayerState {
  const blocks = map.blocks;
  let pos: Vec3 = [...prev.pos];
  const vel: Vec3 = [...prev.vel];

  let crouched = prev.crouched;
  if (cmd.crouch) {
    crouched = true;
  } else if (crouched) {
    const [min, max] = bounds(pos, PLAYER.standHeight);
    if (!overlapsAny(blocks, min, max)) crouched = false;
  }
  const height = playerHeight(crouched);

  const forward = clamp(cmd.forward, -1, 1);
  const right = clamp(cmd.right, -1, 1);
  const sin = Math.sin(cmd.yaw);
  const cos = Math.cos(cmd.yaw);
  let wishX = -sin * forward + cos * right;
  let wishZ = -cos * forward - sin * right;
  const wishLength = Math.hypot(wishX, wishZ);
  if (wishLength > 0) {
    wishX /= wishLength;
    wishZ /= wishLength;
  }
  let maxSpeed = MOVEMENT.runSpeed;
  if (crouched) maxSpeed = MOVEMENT.crouchSpeed;
  else if (cmd.sprint) maxSpeed = MOVEMENT.sprintSpeed;
  const wishSpeed = maxSpeed * Math.min(wishLength, 1);

  const jumped = prev.onGround && cmd.jump && !prev.jumpHeld;
  const grounded = prev.onGround && !jumped;
  if (jumped) vel[1] = MOVEMENT.jumpSpeed;
  if (grounded) {
    applyFriction(vel, dt);
    accelerate(vel, wishX, wishZ, wishSpeed, MOVEMENT.groundAccel, dt);
  } else {
    accelerate(vel, wishX, wishZ, wishSpeed, MOVEMENT.airAccel, dt);
  }
  vel[1] -= MOVEMENT.gravity * dt;

  const dx = vel[0] * dt;
  const dz = vel[2] * dt;
  let move = moveHorizontal(blocks, pos, height, dx, dz);
  if (grounded && (move.hitX || move.hitZ)) {
    const stepped = moveWithStep(blocks, pos, height, dx, dz);
    if (travelled(pos, stepped.pos) > travelled(pos, move.pos) + 1e-6) move = stepped;
  }
  pos = move.pos;
  if (move.hitX) vel[0] = 0;
  if (move.hitZ) vel[2] = 0;

  let onGround = false;
  const dy = vel[1] * dt;
  let [min, max] = bounds(pos, height);
  const movedY = sweepAxis(blocks, min, max, 1, dy);
  pos[1] += movedY;
  if (movedY !== dy) {
    onGround = dy < 0;
    vel[1] = 0;
  }

  // Keep contact with the ground when walking down stairs instead of hopping off each step.
  if (grounded && !onGround) {
    [min, max] = bounds(pos, height);
    const drop = sweepAxis(blocks, min, max, 1, -PLAYER.stepHeight);
    if (drop !== -PLAYER.stepHeight) {
      pos[1] += drop;
      vel[1] = 0;
      onGround = true;
    }
  }

  return { pos, vel, yaw: cmd.yaw, pitch: cmd.pitch, onGround, crouched, jumpHeld: cmd.jump };
}
