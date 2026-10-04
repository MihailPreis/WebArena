import type { View } from './render/renderer';
import { PLAYER } from './sim/constants';
import type { Vec3 } from './sim/map';
import { eyeHeight, isDashing, type PlayerState } from './sim/movement';

const EYE_RATE = 14;
const STEP_RATE = 18;
// Where the camera sinks to when the player dies.
const DEAD_EYE_HEIGHT = 0.35;
const CORRECTION_RATE = 12;
// The view widens quickly when a dash starts and settles back more slowly.
const RUSH_IN_RATE = 30;
const RUSH_OUT_RATE = 7;
// Larger server corrections (a respawn) are shown at once instead of being smoothed.
const MAX_SMOOTHED_CORRECTION = 2;

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
  private correction: Vec3 = [0, 0, 0];
  private rush = 0;

  /** Forgets all smoothing, e.g. after a respawn, so the camera does not glide across the map. */
  reset(): void {
    this.eye = PLAYER.standEyeHeight;
    this.feetY = null;
    this.correction = [0, 0, 0];
    this.rush = 0;
  }

  /**
   * Call when a server correction moved the predicted position by `-delta`:
   * the camera keeps its place and then eases to the corrected position.
   */
  nudge(delta: Vec3): void {
    const next: Vec3 = [
      this.correction[0] + delta[0],
      this.correction[1] + delta[1],
      this.correction[2] + delta[2],
    ];
    if (Math.hypot(...next) > MAX_SMOOTHED_CORRECTION) {
      this.correction = [0, 0, 0];
      this.feetY = null;
    } else {
      this.correction = next;
    }
  }

  update(
    prev: PlayerState,
    cur: PlayerState,
    alpha: number,
    yaw: number,
    pitch: number,
    dt: number,
    dead = false,
  ): View {
    const lerp = (axis: 0 | 1 | 2) => prev.pos[axis] + (cur.pos[axis] - prev.pos[axis]) * alpha;
    const feetY = lerp(1);

    const eyeTarget = dead ? DEAD_EYE_HEIGHT : eyeHeight(cur.crouched);
    this.eye = approach(this.eye, eyeTarget, dead ? EYE_RATE / 3 : EYE_RATE, dt);
    // Only steps are smoothed; jumps and falls must follow the simulation exactly.
    const stepping =
      this.feetY !== null && cur.onGround && Math.abs(feetY - this.feetY) <= PLAYER.stepHeight;
    this.feetY =
      stepping && this.feetY !== null ? approach(this.feetY, feetY, STEP_RATE, dt) : feetY;

    const decay = Math.exp(-CORRECTION_RATE * dt);
    this.correction = [
      this.correction[0] * decay,
      this.correction[1] * decay,
      this.correction[2] * decay,
    ];

    const eye: Vec3 = [
      lerp(0) + this.correction[0],
      this.feetY + this.eye + this.correction[1],
      lerp(2) + this.correction[2],
    ];
    const dashing = !dead && isDashing(cur);
    this.rush = approach(this.rush, dashing ? 1 : 0, dashing ? RUSH_IN_RATE : RUSH_OUT_RATE, dt);
    return { eye, yaw, pitch, rush: this.rush };
  }
}
