import constants from '@shared/constants.json';

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

export interface MapItem {
  /** A key of `items.types` in shared/constants.json. */
  type: string;
  /** The point on the floor the item hovers over. */
  position: Vec3;
}

/** A volume that throws whoever touches it. */
export interface JumpPad {
  min: Vec3;
  max: Vec3;
  /** The velocity the player leaves with, in metres per second. */
  velocity: Vec3;
}

/** A volume that moves whoever touches it somewhere else. */
export interface Teleporter {
  min: Vec3;
  max: Vec3;
  /** Where the player's feet end up. */
  to: Vec3;
  /** Radians; the way the player faces and keeps moving on arrival. */
  yaw: number;
  /** Unit vector of `yaw`. */
  direction: Vec3;
}

/** Decoration: it has no part in the simulation, and the server ignores it. */
export interface MapProp {
  /** What it is; how that looks is up to the renderer. */
  type: string;
  /** The point on the floor it stands on. */
  position: Vec3;
  /** Radians. */
  yaw: number;
}

export interface GameMap {
  name: string;
  killY: number;
  blocks: Block[];
  spawns: Spawn[];
  items: MapItem[];
  pads: JumpPad[];
  teleporters: Teleporter[];
  props: MapProp[];
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

function parseBox(raw: Record<string, unknown>, where: string): { min: Vec3; max: Vec3 } {
  const min = parseVec3(raw.min, `${where}.min`);
  const max = parseVec3(raw.max, `${where}.max`);
  if (min.some((value, axis) => value >= (max[axis] ?? value))) {
    throw new Error(`${where}: min must be below max on every axis`);
  }
  return { min, max };
}

/** Validates raw map JSON (see shared/README.md) and converts it to the runtime form. */
export function parseMap(raw: unknown): GameMap {
  if (!isRecord(raw)) throw new Error('map: expected an object');
  const { name, killY, blocks, spawns } = raw;
  const items = raw.items ?? [];
  const props = raw.props ?? [];
  const pads = raw.jumpPads ?? [];
  const teleporters = raw.teleporters ?? [];
  if (typeof name !== 'string') throw new Error('map.name: expected a string');
  if (typeof killY !== 'number') throw new Error('map.killY: expected a number');
  if (!Array.isArray(blocks)) throw new Error('map.blocks: expected an array');
  if (!Array.isArray(spawns) || spawns.length === 0) {
    throw new Error('map.spawns: expected a non-empty array');
  }
  if (!Array.isArray(items)) throw new Error('map.items: expected an array');
  if (!Array.isArray(props)) throw new Error('map.props: expected an array');
  if (!Array.isArray(pads)) throw new Error('map.jumpPads: expected an array');
  if (!Array.isArray(teleporters)) throw new Error('map.teleporters: expected an array');

  return {
    name,
    killY,
    blocks: blocks.map((block: unknown, i): Block => {
      const where = `map.blocks[${i}]`;
      if (!isRecord(block)) throw new Error(`${where}: expected an object`);
      const { min, max } = parseBox(block, where);
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
    items: items.map((item: unknown, i): MapItem => {
      const where = `map.items[${i}]`;
      if (!isRecord(item)) throw new Error(`${where}: expected an object`);
      if (typeof item.type !== 'string' || !(item.type in constants.items.types)) {
        throw new Error(`${where}.type: unknown item`);
      }
      return { type: item.type, position: parseVec3(item.position, `${where}.position`) };
    }),
    pads: pads.map((pad: unknown, i): JumpPad => {
      const where = `map.jumpPads[${i}]`;
      if (!isRecord(pad)) throw new Error(`${where}: expected an object`);
      return { ...parseBox(pad, where), velocity: parseVec3(pad.velocity, `${where}.velocity`) };
    }),
    teleporters: teleporters.map((gate: unknown, i): Teleporter => {
      const where = `map.teleporters[${i}]`;
      if (!isRecord(gate)) throw new Error(`${where}: expected an object`);
      if (typeof gate.yawDeg !== 'number') throw new Error(`${where}.yawDeg: expected a number`);
      const yaw = (gate.yawDeg * Math.PI) / 180;
      return {
        ...parseBox(gate, where),
        to: parseVec3(gate.to, `${where}.to`),
        yaw,
        direction: [-Math.sin(yaw), 0, -Math.cos(yaw)],
      };
    }),
    props: props.map((prop: unknown, i): MapProp => {
      const where = `map.props[${i}]`;
      if (!isRecord(prop)) throw new Error(`${where}: expected an object`);
      if (typeof prop.type !== 'string') throw new Error(`${where}.type: expected a string`);
      const yawDeg = prop.yawDeg ?? 0;
      if (typeof yawDeg !== 'number') throw new Error(`${where}.yawDeg: expected a number`);
      return {
        type: prop.type,
        position: parseVec3(prop.position, `${where}.position`),
        yaw: (yawDeg * Math.PI) / 180,
      };
    }),
  };
}
