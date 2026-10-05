// Mirror of server/arena/game/weapon.py. Change both together.
//
// Timing is counted in simulation ticks, i.e. in player inputs, so the client can
// predict its own weapons exactly.
import constants from '@shared/constants.json';

export const WEAPONS = constants.weapons;
export const SWITCH_TICKS = constants.combat.switchTicks;

export interface WeaponState {
  /** Index of the weapon in hand. */
  current: number;
  /** Rounds left for each weapon. */
  ammo: readonly number[];
  /** Bit `i` is set when weapon `i` has been picked up. */
  owned: number;
  /** Ticks until the next shot is allowed. */
  cooldown: number;
}

export function createWeapon(): WeaponState {
  return {
    current: 0,
    ammo: WEAPONS.map((spec) => spec.startAmmo),
    // A player spawns holding every weapon that comes with ammunition.
    owned: WEAPONS.reduce((bits, spec, i) => (spec.startAmmo > 0 ? bits | (1 << i) : bits), 0),
    cooldown: 0,
  };
}

/** Whether the player has the weapon and something to fire from it. */
export function usable(state: WeaponState, index: number): boolean {
  return ((state.owned >> index) & 1) === 1 && (state.ammo[index] ?? 0) > 0;
}

/**
 * Advances the weapons by one tick; `want` is the weapon the player asks for.
 * Pure: returns the new state and whether a shot was fired, from `current` of that state.
 */
export function stepWeapon(
  prev: WeaponState,
  fire: boolean,
  want: number,
): { weapon: WeaponState; fired: boolean } {
  let current = prev.current;
  let ammo = prev.ammo;
  let cooldown = Math.max(prev.cooldown - 1, 0);
  let fired = false;

  let next = current;
  if (want !== current && usable(prev, want)) {
    next = want;
  } else if ((ammo[current] ?? 0) === 0) {
    // Out of ammunition: fall back to the best weapon that still has some.
    for (let index = WEAPONS.length - 1; index >= 0; index--) {
      if (usable(prev, index)) {
        next = index;
        break;
      }
    }
  }
  if (next !== current) {
    current = next;
    cooldown = Math.max(cooldown, SWITCH_TICKS);
  }

  const spec = WEAPONS[current];
  if (spec && fire && cooldown === 0 && (ammo[current] ?? 0) > 0) {
    ammo = ammo.map((rounds, index) => (index === current ? rounds - 1 : rounds));
    cooldown = spec.intervalTicks;
    fired = true;
  }

  return { weapon: { current, ammo, owned: prev.owned, cooldown }, fired };
}
