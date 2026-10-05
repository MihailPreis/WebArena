import arenaJson from '@shared/maps/arena.json';
import { describe, expect, it } from 'vitest';
import { overlapsAny } from '../sim/collision';
import { parseMap, type Vec3 } from '../sim/map';
import { PROP_MODELS } from './propModels';

const arena = parseMap(arenaJson);

describe('props of the arena', () => {
  it('are all of a known type', () => {
    expect(arena.props.length).toBeGreaterThan(0);
    for (const prop of arena.props) expect(Object.keys(PROP_MODELS)).toContain(prop.type);
  });

  it('stand on something and not inside a block', () => {
    for (const prop of arena.props) {
      const [x, y, z] = prop.position;
      const parts = PROP_MODELS[prop.type] ?? [];
      const reach = Math.max(
        ...parts.flatMap((p) => [p.min[0], p.max[0], p.min[2], p.max[2]].map(Math.abs)),
      );
      const height = Math.max(...parts.map((part) => part.max[1]));
      const min: Vec3 = [x - reach, y + 0.01, z - reach];
      const max: Vec3 = [x + reach, y + height, z + reach];
      expect(overlapsAny(arena.blocks, min, max), JSON.stringify(prop)).toBe(false);
      const under = overlapsAny(
        arena.blocks,
        [x - 0.01, y - 0.1, z - 0.01],
        [x + 0.01, y - 0.01, z + 0.01],
      );
      expect(under, JSON.stringify(prop)).toBe(true);
    }
  });

  it('keep clear of spawn points and items', () => {
    const places = [...arena.spawns, ...arena.items].map((thing) => thing.position);
    for (const prop of arena.props) {
      for (const place of places) {
        const gap = Math.hypot(prop.position[0] - place[0], prop.position[2] - place[2]);
        const sameFloor = Math.abs(prop.position[1] - place[1]) < 1.5;
        expect(sameFloor && gap < 1.5, JSON.stringify(prop)).toBe(false);
      }
    }
  });
});
