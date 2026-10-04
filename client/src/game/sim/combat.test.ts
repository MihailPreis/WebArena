import { describe, expect, it } from 'vitest';
import type { GameMap } from './map';
import { aimDirection, rayBox, shotEnd } from './ray';
import { createWeapon, stepWeapon, WEAPON } from './weapon';

describe('weapon', () => {
  it('fires at the configured rate', () => {
    let weapon = createWeapon();
    let shots = 0;
    for (let i = 0; i < WEAPON.fireIntervalTicks * 3; i++) {
      const step = stepWeapon(weapon, true, false);
      weapon = step.weapon;
      shots += Number(step.fired);
    }
    expect(shots).toBe(3);
    expect(weapon.ammo).toBe(WEAPON.magazine - 3);
  });

  it('reloads on its own when empty and cannot fire meanwhile', () => {
    let weapon = { ammo: 1, cooldown: 0, reload: 0 };
    expect(stepWeapon(weapon, true, false).fired).toBe(true);
    weapon = stepWeapon(weapon, true, false).weapon;
    weapon = stepWeapon(weapon, true, false).weapon;
    expect(weapon.reload).toBe(WEAPON.reloadTicks);
    for (let i = 0; i < WEAPON.reloadTicks - 1; i++) {
      const step = stepWeapon(weapon, true, false);
      expect(step.fired).toBe(false);
      weapon = step.weapon;
    }
    weapon = stepWeapon(weapon, true, false).weapon;
    expect(weapon).toMatchObject({ ammo: WEAPON.magazine, reload: 0 });
  });

  it('reloads by hand only when the magazine is not full', () => {
    expect(stepWeapon(createWeapon(), false, true).weapon.reload).toBe(0);
    const partial = { ammo: 5, cooldown: 0, reload: 0 };
    expect(stepWeapon(partial, false, true).weapon.reload).toBe(WEAPON.reloadTicks);
  });
});

describe('rays', () => {
  const map: GameMap = {
    name: 'range',
    killY: -20,
    blocks: [{ min: [-50, 0, -11], max: [50, 5, -10], material: 'wall' }],
    spawns: [],
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
    expect(shotEnd(map, [0, 1, 0], [0, 0, 1], [])[2]).toBeCloseTo(WEAPON.range);
  });
});
