import { TICK_DT } from '../sim/constants';
import type { GameMap, Vec3 } from '../sim/map';
import { stepPlayer, type InputCmd, type PlayerState } from '../sim/movement';
import { stepWeapon, type WeaponState } from '../sim/weapon';
import type { SelfStatus } from './protocol';

function weaponOf(status: SelfStatus): WeaponState {
  return {
    current: status.weapon,
    ammo: status.ammo,
    owned: status.owned,
    cooldown: status.cooldown,
  };
}

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
  weapon: WeaponState;
  /** Whether inputs have any effect: false while dead or frozen. Only the server decides. */
  active: boolean;
  private pending: { seq: number; cmd: InputCmd }[] = [];
  private nextSeq = 0;

  constructor(
    private readonly map: GameMap,
    initial: PlayerState,
    status: SelfStatus,
  ) {
    this.current = initial;
    this.previous = initial;
    this.weapon = weaponOf(status);
    this.active = status.alive && !status.frozen;
  }

  /**
   * Simulates one tick. Returns the sequence number to send with the input and
   * whether the weapon in hand (`this.weapon.current`) fired, so the caller can play
   * the shot at once.
   */
  step(cmd: InputCmd): { seq: number; fired: boolean } {
    const seq = this.nextSeq++;
    this.pending.push({ seq, cmd });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.previous = this.current;
    if (!this.active) return { seq, fired: false };

    this.current = stepPlayer(this.current, cmd, this.map, TICK_DT);
    const { weapon, fired } = stepWeapon(this.weapon, cmd.fire, cmd.weapon);
    this.weapon = weapon;
    return { seq, fired };
  }

  /**
   * Adopts the server state as of input `ack` and replays later inputs.
   * Returns how far the predicted position moved as a result (old minus new),
   * which is zero when the prediction was right.
   */
  reconcile(serverState: PlayerState, status: SelfStatus, ack: number): Vec3 {
    const before = this.current.pos;
    this.pending = this.pending.filter((input) => input.seq > ack);
    this.active = status.alive && !status.frozen;

    let state = serverState;
    let previous = serverState;
    let weapon = weaponOf(status);
    if (this.active) {
      for (const { cmd } of this.pending) {
        previous = state;
        state = stepPlayer(state, cmd, this.map, TICK_DT);
        weapon = stepWeapon(weapon, cmd.fire, cmd.weapon).weapon;
      }
    }
    this.previous = previous;
    this.current = state;
    this.weapon = weapon;
    return [before[0] - state.pos[0], before[1] - state.pos[1], before[2] - state.pos[2]];
  }
}
