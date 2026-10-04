import type { Block, Vec3 } from './map';

export type Axis = 0 | 1 | 2;

const EPSILON = 1e-4;

/**
 * Sweeps the box [min, max] along one axis and returns how far it can travel
 * before touching a block (same sign as `delta`, never larger in magnitude).
 * Blocks the box already penetrates along that axis are ignored, so a box that
 * ends up a rounding error inside a wall can still slide along it.
 */
export function sweepAxis(
  blocks: readonly Block[],
  min: Vec3,
  max: Vec3,
  axis: Axis,
  delta: number,
): number {
  if (delta === 0) return 0;
  const a1 = ((axis + 1) % 3) as Axis;
  const a2 = ((axis + 2) % 3) as Axis;
  let allowed = delta;
  for (const block of blocks) {
    if (
      block.max[a1] <= min[a1] ||
      block.min[a1] >= max[a1] ||
      block.max[a2] <= min[a2] ||
      block.min[a2] >= max[a2]
    ) {
      continue;
    }
    if (delta > 0) {
      const gap = block.min[axis] - max[axis];
      if (gap >= -EPSILON && gap < allowed) allowed = Math.max(gap, 0);
    } else {
      const gap = block.max[axis] - min[axis];
      if (gap <= EPSILON && gap > allowed) allowed = Math.min(gap, 0);
    }
  }
  return allowed;
}

/** True if the box [min, max] overlaps any block by more than a rounding error. */
export function overlapsAny(blocks: readonly Block[], min: Vec3, max: Vec3): boolean {
  return blocks.some(
    (block) =>
      block.max[0] > min[0] + EPSILON &&
      block.min[0] < max[0] - EPSILON &&
      block.max[1] > min[1] + EPSILON &&
      block.min[1] < max[1] - EPSILON &&
      block.max[2] > min[2] + EPSILON &&
      block.min[2] < max[2] - EPSILON,
  );
}
