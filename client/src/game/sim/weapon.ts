// Mirror of server/arena/game/weapon.py. Change both together.
//
// Timing is counted in simulation ticks, i.e. in player inputs, so the client can
// predict its own weapon exactly.
import constants from '@shared/constants.json';

export const WEAPON = constants.weapon;

export interface WeaponState {
  ammo: number;
  /** Ticks until the next shot is allowed. */
  cooldown: number;
  /** Ticks of reloading left; 0 when not reloading. */
  reload: number;
}

export function createWeapon(): WeaponState {
  return { ammo: WEAPON.magazine, cooldown: 0, reload: 0 };
}

/** Advances the weapon by one tick. Pure: returns the new state and whether a shot was fired. */
export function stepWeapon(
  prev: WeaponState,
  fire: boolean,
  reload: boolean,
): { weapon: WeaponState; fired: boolean } {
  let ammo = prev.ammo;
  let cooldown = Math.max(prev.cooldown - 1, 0);
  let reloading = prev.reload;
  let fired = false;

  if (reloading > 0) {
    reloading -= 1;
    if (reloading === 0) ammo = WEAPON.magazine;
  } else if ((reload && ammo < WEAPON.magazine) || ammo === 0) {
    reloading = WEAPON.reloadTicks;
  } else if (fire && cooldown === 0) {
    ammo -= 1;
    cooldown = WEAPON.fireIntervalTicks;
    fired = true;
  }

  return { weapon: { ammo, cooldown, reload: reloading }, fired };
}
