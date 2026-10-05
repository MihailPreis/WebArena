// Shot tracing for the client's own effects (where a tracer ends). The server decides
// what was actually hit; see server/arena/game/combat.py.
import constants from '@shared/constants.json';
import { PLAYER } from './constants';
import type { Block, GameMap, Vec3 } from './map';

export const WEAPON_RANGE = constants.combat.range;

/** Unit vector the player looks along. Yaw 0 looks along -z; positive pitch looks up. */
export function aimDirection(yaw: number, pitch: number): Vec3 {
  const horizontal = Math.cos(pitch);
  return [-Math.sin(yaw) * horizontal, Math.sin(pitch), -Math.cos(yaw) * horizontal];
}

/**
 * Where each pellet of a shot flies. The pattern is fixed, not random: one pellet along
 * the aim and the rest on two rings around it. Mirrors `pellet_directions` on the server.
 */
export function pelletDirections(
  yaw: number,
  pitch: number,
  pellets: number,
  spread: number,
): Vec3[] {
  const forward = aimDirection(yaw, pitch);
  if (pellets <= 1) return [forward];
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const right: Vec3 = [cosYaw, 0, -sinYaw];
  const up: Vec3 = [
    sinYaw * forward[1],
    -sinYaw * forward[0] - cosYaw * forward[2],
    cosYaw * forward[1],
  ];
  const directions = [forward];
  for (let i = 1; i < pellets; i++) {
    const radius = spread * (i % 2 === 1 ? 0.5 : 1);
    const angle = (2 * Math.PI * i) / (pellets - 1);
    const a = Math.cos(angle) * radius;
    const b = Math.sin(angle) * radius;
    const x = forward[0] + right[0] * a + up[0] * b;
    const y = forward[1] + right[1] * a + up[1] * b;
    const z = forward[2] + right[2] * a + up[2] * b;
    const length = Math.sqrt(x * x + y * y + z * z);
    directions.push([x / length, y / length, z / length]);
  }
  return directions;
}

/** Distance along the ray to where it enters the box, or null if it misses. */
export function rayBox(origin: Vec3, direction: Vec3, min: Vec3, max: Vec3): number | null {
  let near = 0;
  let far = Infinity;
  for (const axis of [0, 1, 2] as const) {
    const d = direction[axis];
    if (d === 0) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
      continue;
    }
    let t1 = (min[axis] - origin[axis]) / d;
    let t2 = (max[axis] - origin[axis]) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (near > far) return null;
  }
  return near;
}

/** Where a shot visibly stops: on a wall, on a player, or at maximum range. */
export function shotEnd(
  map: GameMap,
  origin: Vec3,
  direction: Vec3,
  players: readonly { pos: Vec3; crouched: boolean }[],
): Vec3 {
  let nearest = WEAPON_RANGE;
  for (const block of map.blocks) {
    const distance = rayBox(origin, direction, block.min, block.max);
    if (distance !== null && distance < nearest) nearest = distance;
  }
  const r = PLAYER.halfWidth;
  for (const { pos, crouched } of players) {
    const height = crouched ? PLAYER.crouchHeight : PLAYER.standHeight;
    const distance = rayBox(
      origin,
      direction,
      [pos[0] - r, pos[1], pos[2] - r],
      [pos[0] + r, pos[1] + height, pos[2] + r],
    );
    if (distance !== null && distance < nearest) nearest = distance;
  }
  return [
    origin[0] + direction[0] * nearest,
    origin[1] + direction[1] * nearest,
    origin[2] + direction[2] * nearest,
  ];
}

export interface Surface {
  block: Block;
  /** Unit vector pointing out of the face. */
  normal: Vec3;
  /** Distance from the point to the nearest edge of the face, in metres. */
  room: number;
}

// How far off a face a point may be and still count as lying on it.
const SURFACE_EPSILON = 0.01;

/** The face of the map that `point` lies on, e.g. where a shot stopped; null in the open. */
export function surfaceAt(map: GameMap, point: Vec3): Surface | null {
  const e = SURFACE_EPSILON;
  for (const block of map.blocks) {
    const { min, max } = block;
    const inside = ([0, 1, 2] as const).every(
      (axis) => point[axis] >= min[axis] - e && point[axis] <= max[axis] + e,
    );
    if (!inside) continue;
    for (const axis of [0, 1, 2] as const) {
      const sign =
        Math.abs(point[axis] - max[axis]) <= e
          ? 1
          : Math.abs(point[axis] - min[axis]) <= e
            ? -1
            : 0;
      if (sign === 0) continue;
      const normal: Vec3 = [0, 0, 0];
      normal[axis] = sign;
      const room = Math.min(
        ...([0, 1, 2] as const)
          .filter((other) => other !== axis)
          .map((other) => Math.min(point[other] - min[other], max[other] - point[other])),
      );
      return { block, normal, room: Math.max(room, 0) };
    }
  }
  return null;
}
