export type Vec3 = [number, number, number];

export interface Block {
  min: Vec3;
  max: Vec3;
  material: string;
}

export interface Spawn {
  position: Vec3;
  /** Radians; 0 looks along -z. */
  yaw: number;
}

export interface GameMap {
  name: string;
  killY: number;
  blocks: Block[];
  spawns: Spawn[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseVec3(value: unknown, where: string): Vec3 {
  const [x, y, z]: unknown[] = Array.isArray(value) ? value : [];
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {
    throw new Error(`${where}: expected [x, y, z]`);
  }
  return [x as number, y as number, z as number];
}

/** Validates raw map JSON (see shared/README.md) and converts it to the runtime form. */
export function parseMap(raw: unknown): GameMap {
  if (!isRecord(raw)) throw new Error('map: expected an object');
  const { name, killY, blocks, spawns } = raw;
  if (typeof name !== 'string') throw new Error('map.name: expected a string');
  if (typeof killY !== 'number') throw new Error('map.killY: expected a number');
  if (!Array.isArray(blocks)) throw new Error('map.blocks: expected an array');
  if (!Array.isArray(spawns) || spawns.length === 0) {
    throw new Error('map.spawns: expected a non-empty array');
  }

  return {
    name,
    killY,
    blocks: blocks.map((block: unknown, i): Block => {
      const where = `map.blocks[${i}]`;
      if (!isRecord(block)) throw new Error(`${where}: expected an object`);
      const min = parseVec3(block.min, `${where}.min`);
      const max = parseVec3(block.max, `${where}.max`);
      if (min.some((value, axis) => value >= (max[axis] ?? value))) {
        throw new Error(`${where}: min must be below max on every axis`);
      }
      if (typeof block.material !== 'string') {
        throw new Error(`${where}.material: expected a string`);
      }
      return { min, max, material: block.material };
    }),
    spawns: spawns.map((spawn: unknown, i): Spawn => {
      const where = `map.spawns[${i}]`;
      if (!isRecord(spawn)) throw new Error(`${where}: expected an object`);
      if (typeof spawn.yawDeg !== 'number') throw new Error(`${where}.yawDeg: expected a number`);
      return {
        position: parseVec3(spawn.position, `${where}.position`),
        yaw: (spawn.yawDeg * Math.PI) / 180,
      };
    }),
  };
}
