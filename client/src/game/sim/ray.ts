// Shot tracing for the client's own effects (where a tracer ends). The server decides
// what was actually hit; see server/arena/game/combat.py.
import { PLAYER } from './constants';
import type { GameMap, Vec3 } from './map';
import { WEAPON } from './weapon';

/** Unit vector the player looks along. Yaw 0 looks along -z; positive pitch looks up. */
export function aimDirection(yaw: number, pitch: number): Vec3 {
  const horizontal = Math.cos(pitch);
  return [-Math.sin(yaw) * horizontal, Math.sin(pitch), -Math.cos(yaw) * horizontal];
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
  let nearest = WEAPON.range;
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
