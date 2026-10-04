import type { Vec3 } from '../sim/map';
import type { RemoteState } from './protocol';

// Snapshots older than this are of no use for interpolation.
const HISTORY_S = 1;
// A jump this large between two snapshots is a respawn, not movement.
const TELEPORT_DISTANCE = 5;
const CLOCK_SMOOTHING = 0.1;

interface Sample {
  time: number;
  pos: Vec3;
  yaw: number;
  crouched: boolean;
  dashing: boolean;
}

export interface InterpolatedPlayer {
  id: string;
  pos: Vec3;
  yaw: number;
  crouched: boolean;
  dashing: boolean;
}

function lerpAngle(from: number, to: number, alpha: number): number {
  let delta = (to - from) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return from + delta * alpha;
}

/**
 * Shows other players slightly in the past, so there are always two snapshots
 * to interpolate between and their movement stays smooth despite network jitter.
 */
export class RemoteInterpolator {
  private readonly history = new Map<string, Sample[]>();
  /** Local time minus server time, smoothed. */
  private clockOffset: number | null = null;

  constructor(private readonly delay: number) {}

  /** Records a snapshot taken at `serverTime` and received at `localTime` (seconds). */
  push(serverTime: number, localTime: number, players: readonly RemoteState[]): void {
    const offset = localTime - serverTime;
    this.clockOffset =
      this.clockOffset === null
        ? offset
        : this.clockOffset + (offset - this.clockOffset) * CLOCK_SMOOTHING;

    const present = new Set<string>();
    for (const player of players) {
      present.add(player.id);
      let samples = this.history.get(player.id);
      if (!samples) this.history.set(player.id, (samples = []));
      samples.push({
        time: serverTime,
        pos: player.pos,
        yaw: player.yaw,
        crouched: player.crouched,
        dashing: player.dashing,
      });
      while (samples.length > 2 && (samples[0]?.time ?? 0) < serverTime - HISTORY_S) {
        samples.shift();
      }
    }
    for (const id of this.history.keys()) {
      if (!present.has(id)) this.history.delete(id);
    }
  }

  /** Server time that is being drawn at `localTime`; 0 before the first snapshot. */
  renderTime(localTime: number): number {
    if (this.clockOffset === null) return 0;
    return Math.max(localTime - this.clockOffset - this.delay, 0);
  }

  /** Where every remote player should be drawn at `localTime`. */
  sample(localTime: number): InterpolatedPlayer[] {
    if (this.clockOffset === null) return [];
    const time = this.renderTime(localTime);
    const result: InterpolatedPlayer[] = [];

    for (const [id, samples] of this.history) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (!first || !last) continue;

      let from = first;
      let to = first;
      if (time >= last.time) {
        from = to = last; // No newer data: hold the last known position.
      } else if (time > first.time) {
        for (let i = 1; i < samples.length; i++) {
          const next = samples[i];
          const prev = samples[i - 1];
          if (next && prev && next.time >= time) {
            from = prev;
            to = next;
            break;
          }
        }
      }

      const span = to.time - from.time;
      const distance = Math.hypot(
        to.pos[0] - from.pos[0],
        to.pos[1] - from.pos[1],
        to.pos[2] - from.pos[2],
      );
      const alpha = span > 0 && distance < TELEPORT_DISTANCE ? (time - from.time) / span : 1;
      const lerp = (axis: 0 | 1 | 2) => from.pos[axis] + (to.pos[axis] - from.pos[axis]) * alpha;
      result.push({
        id,
        pos: [lerp(0), lerp(1), lerp(2)],
        yaw: lerpAngle(from.yaw, to.yaw, alpha),
        crouched: alpha < 0.5 ? from.crouched : to.crouched,
        dashing: from.dashing || to.dashing,
      });
    }
    return result;
  }
}
