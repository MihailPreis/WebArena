import { TICK_DT } from '../sim/constants';
import type { GameMap, Vec3 } from '../sim/map';
import { stepPlayer, type InputCmd, type PlayerState } from '../sim/movement';

// If the server stops acknowledging, do not grow the replay buffer without bound.
const MAX_PENDING = 240;

/**
 * Client-side prediction of the local player. Inputs are applied immediately and
 * remembered; when the server reports its authoritative state, the inputs it has
 * not simulated yet are replayed on top of it.
 */
export class Prediction {
  /** State after the latest simulated tick. */
  current: PlayerState;
  /** State one tick earlier, for interpolating between ticks when rendering. */
  previous: PlayerState;
  private pending: { seq: number; cmd: InputCmd }[] = [];
  private nextSeq = 0;

  constructor(
    private readonly map: GameMap,
    initial: PlayerState,
  ) {
    this.current = initial;
    this.previous = initial;
  }

  /** Simulates one tick and returns the sequence number to send with the input. */
  step(cmd: InputCmd): number {
    const seq = this.nextSeq++;
    this.pending.push({ seq, cmd });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.previous = this.current;
    this.current = stepPlayer(this.current, cmd, this.map, TICK_DT);
    return seq;
  }

  /**
   * Adopts the server state as of input `ack` and replays later inputs.
   * Returns how far the predicted position moved as a result (old minus new),
   * which is zero when the prediction was right.
   */
  reconcile(serverState: PlayerState, ack: number): Vec3 {
    const before = this.current.pos;
    this.pending = this.pending.filter((input) => input.seq > ack);

    let state = serverState;
    let previous = serverState;
    for (const { cmd } of this.pending) {
      previous = state;
      state = stepPlayer(state, cmd, this.map, TICK_DT);
    }
    this.previous = previous;
    this.current = state;
    return [before[0] - state.pos[0], before[1] - state.pos[1], before[2] - state.pos[2]];
  }
}
