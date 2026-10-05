import { describe, expect, it } from 'vitest';
import type { GameMap } from './map';
import { aimDirection, pelletDirections, rayBox, shotEnd, WEAPON_RANGE } from './ray';
import {
  createWeapon,
  stepWeapon,
  SWITCH_TICKS,
  usable,
  WEAPONS,
  type WeaponState,
} from './weapon';

function weapon(index: number) {
  const spec = WEAPONS[index];
  if (!spec) throw new Error(`weapon ${index} is missing`);
  return spec;
}
const MACHINEGUN = weapon(0);
const SHOTGUN = weapon(1);

const ARMED: WeaponState = { current: 0, ammo: [50, 5, 0, 1], owned: 0b1111, cooldown: 0 };

describe('weapon', () => {
  it('fires at the configured rate', () => {
    let weapon = createWeapon();
    let shots = 0;
    for (let i = 0; i < MACHINEGUN.intervalTicks * 3; i++) {
      const step = stepWeapon(weapon, true, 0);
      weapon = step.weapon;
      shots += Number(step.fired);
    }
    expect(shots).toBe(3);
    expect(weapon.ammo[0]).toBe(MACHINEGUN.startAmmo - 3);
  });

  it('starts with the first weapon only', () => {
    const weapon = createWeapon();
    expect(weapon.owned).toBe(1);
    expect(usable(weapon, 0)).toBe(true);
    expect(stepWeapon(weapon, false, 3).weapon.current).toBe(0);
  });

  it('takes time to switch', () => {
    let step = stepWeapon(ARMED, true, 3);
    expect(step.weapon.current).toBe(3);
    expect(step.fired).toBe(false);
    for (let i = 0; i < SWITCH_TICKS - 1; i++) {
      step = stepWeapon(step.weapon, true, 3);
      expect(step.fired).toBe(false);
    }
    step = stepWeapon(step.weapon, true, 3);
    expect(step.fired).toBe(true);
    expect(step.weapon.ammo[3]).toBe(0);
  });

  it('falls back to the best loaded weapon when empty', () => {
    const empty = { ...ARMED, current: 3, ammo: [50, 5, 0, 0] };
    expect(stepWeapon(empty, true, 3).weapon.current).toBe(1);
    // Asking for an empty weapon changes nothing.
    expect(stepWeapon({ ...empty, current: 1 }, false, 2).weapon.current).toBe(1);
  });
});

describe('rays', () => {
  const map: GameMap = {
    name: 'range',
    killY: -20,
    blocks: [{ min: [-50, 0, -11], max: [50, 5, -10], material: 'wall' }],
    spawns: [],
    items: [],
  };

  it('aims along -z at yaw 0 and up with positive pitch', () => {
    const forward = aimDirection(0, 0);
    expect(forward[2]).toBeCloseTo(-1);
    expect(aimDirection(Math.PI / 2, 0)[0]).toBeCloseTo(-1);
    expect(aimDirection(0, Math.PI / 2)[1]).toBeCloseTo(1);
  });

  it('finds where a ray enters a box', () => {
    expect(rayBox([0, 1, 0], [0, 0, -1], [-1, 0, -6], [1, 2, -5])).toBe(5);
    expect(rayBox([0, 1, 0], [0, 0, 1], [-1, 0, -6], [1, 2, -5])).toBeNull();
    expect(rayBox([3, 1, 0], [0, 0, -1], [-1, 0, -6], [1, 2, -5])).toBeNull();
  });

  it('stops a shot at the first player or wall', () => {
    const player = { pos: [0, 0, -5] as [number, number, number], crouched: false };
    expect(shotEnd(map, [0, 1, 0], [0, 0, -1], [])[2]).toBeCloseTo(-10);
    expect(shotEnd(map, [0, 1, 0], [0, 0, -1], [player])[2]).toBeCloseTo(-5 + 0.35);
    expect(shotEnd(map, [0, 1, 0], [0, 0, 1], [])[2]).toBeCloseTo(WEAPON_RANGE);
  });

  it('fans the pellets of a shotgun out around the aim', () => {
    const pellets = pelletDirections(0.3, -0.2, SHOTGUN.pellets, SHOTGUN.spread);
    const forward = aimDirection(0.3, -0.2);
    expect(pellets).toHaveLength(SHOTGUN.pellets);
    expect(pellets[0]).toEqual(forward);
    for (const pellet of pellets.slice(1)) {
      expect(Math.hypot(...pellet)).toBeCloseTo(1);
      const cosine = pellet[0] * forward[0] + pellet[1] * forward[1] + pellet[2] * forward[2];
      expect(Math.tan(Math.acos(cosine))).toBeLessThanOrEqual(SHOTGUN.spread + 1e-9);
    }
    // The same numbers as server/tests/test_combat.py gets from `pellet_directions`.
    expect(pellets[1]?.[0]).toBeCloseTo(-0.2636249628, 9);
    expect(pellets[10]?.[1]).toBeCloseTo(-0.1981843724, 9);
  });
});
