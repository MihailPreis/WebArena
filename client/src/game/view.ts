import type { View } from './render/renderer';
import { PLAYER } from './sim/constants';
import type { Vec3 } from './sim/map';
import { eyeHeight, type PlayerState } from './sim/movement';

const EYE_RATE = 14;
const STEP_RATE = 18;

function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/**
 * Turns simulation states into a camera pose: interpolates between ticks and
 * smooths the two things that would otherwise pop — crouching and stair steps.
 */
export class ViewSmoother {
  private eye = PLAYER.standEyeHeight;
  private feetY: number | null = null;

  reset(): void {
    this.eye = PLAYER.standEyeHeight;
    this.feetY = null;
  }

  update(
    prev: PlayerState,
    cur: PlayerState,
    alpha: number,
    yaw: number,
    pitch: number,
    dt: number,
  ): View {
    const lerp = (axis: 0 | 1 | 2) => prev.pos[axis] + (cur.pos[axis] - prev.pos[axis]) * alpha;
    const feetY = lerp(1);

    this.eye = approach(this.eye, eyeHeight(cur.crouched), EYE_RATE, dt);
    // Only steps are smoothed; jumps and falls must follow the simulation exactly.
    const stepping =
      this.feetY !== null && cur.onGround && Math.abs(feetY - this.feetY) <= PLAYER.stepHeight;
    this.feetY =
      stepping && this.feetY !== null ? approach(this.feetY, feetY, STEP_RATE, dt) : feetY;

    const eye: Vec3 = [lerp(0), this.feetY + this.eye, lerp(2)];
    return { eye, yaw, pitch };
  }
}
