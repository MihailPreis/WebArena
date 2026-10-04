import {
  CanvasTexture,
  NearestFilter,
  NearestMipmapNearestFilter,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';

const SIZE = 32;

type Rgb = [number, number, number];
type Painter = (ctx: CanvasRenderingContext2D, random: () => number) => void;

export interface MaterialLook {
  texture: CanvasTexture;
  /** World size of one texture repeat, in metres. */
  tile: number;
}

// Deterministic, so the textures look the same on every load.
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shade([r, g, b]: Rgb, factor: number): string {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value * factor)));
  return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`;
}

function noise(
  ctx: CanvasRenderingContext2D,
  random: () => number,
  base: Rgb,
  amount: number,
): void {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      ctx.fillStyle = shade(base, 1 - amount / 2 + random() * amount);
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

const paintFloor: Painter = (ctx, random) => {
  noise(ctx, random, [74, 72, 82], 0.25);
  ctx.fillStyle = shade([74, 72, 82], 0.55);
  for (const edge of [0, 16]) {
    ctx.fillRect(edge, 0, 1, SIZE);
    ctx.fillRect(0, edge, SIZE, 1);
  }
};

const paintWall: Painter = (ctx, random) => {
  const brick: Rgb = [128, 62, 48];
  ctx.fillStyle = shade([60, 52, 50], 1);
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let row = 0; row < 4; row++) {
    const offset = row % 2 === 0 ? 0 : 8;
    for (let x = -16; x < SIZE; x += 16) {
      ctx.fillStyle = shade(brick, 0.8 + random() * 0.4);
      ctx.fillRect(x + offset + 1, row * 8 + 1, 15, 7);
    }
  }
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = shade(brick, 0.6 + random() * 0.3);
    const x = Math.floor(random() * SIZE);
    const y = Math.floor(random() * SIZE);
    if (y % 8 !== 0) ctx.fillRect(x, y, 1, 1);
  }
};

const paintStone: Painter = (ctx, random) => {
  noise(ctx, random, [112, 110, 104], 0.3);
  ctx.fillStyle = shade([112, 110, 104], 0.6);
  ctx.fillRect(0, 0, SIZE, 1);
  ctx.fillRect(0, 16, SIZE, 1);
  ctx.fillRect(0, 0, 1, 16);
  ctx.fillRect(16, 16, 1, 16);
};

const paintCrate: Painter = (ctx, random) => {
  const wood: Rgb = [150, 104, 54];
  for (let x = 0; x < SIZE; x++) {
    const plank = 0.85 + (Math.floor(x / 8) % 2) * 0.1;
    for (let y = 0; y < SIZE; y++) {
      ctx.fillStyle = shade(wood, plank + random() * 0.15);
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.fillStyle = shade(wood, 0.55);
  ctx.fillRect(0, 0, SIZE, 3);
  ctx.fillRect(0, SIZE - 3, SIZE, 3);
  ctx.fillRect(0, 0, 3, SIZE);
  ctx.fillRect(SIZE - 3, 0, 3, SIZE);
  for (let i = 3; i < SIZE - 3; i++) {
    ctx.fillRect(i, i, 2, 1);
    ctx.fillRect(SIZE - 2 - i, i, 2, 1);
  }
};

const paintMetal: Painter = (ctx, random) => {
  const steel: Rgb = [84, 98, 116];
  noise(ctx, random, steel, 0.12);
  ctx.fillStyle = shade(steel, 0.6);
  ctx.fillRect(0, 0, SIZE, 1);
  ctx.fillRect(0, 0, 1, SIZE);
  ctx.fillStyle = shade(steel, 1.35);
  ctx.fillRect(1, 1, SIZE - 1, 1);
  ctx.fillRect(1, 1, 1, SIZE - 1);
  for (const [x, y] of [
    [4, 4],
    [27, 4],
    [4, 27],
    [27, 27],
  ] as const) {
    ctx.fillStyle = shade(steel, 1.5);
    ctx.fillRect(x, y, 2, 2);
    ctx.fillStyle = shade(steel, 0.5);
    ctx.fillRect(x + 1, y + 1, 1, 1);
  }
};

// Shown for material ids the renderer does not know, so a new map still renders.
const paintMissing: Painter = (ctx) => {
  for (let y = 0; y < SIZE; y += 8) {
    for (let x = 0; x < SIZE; x += 8) {
      ctx.fillStyle = (x + y) % 16 === 0 ? '#c0c' : '#222';
      ctx.fillRect(x, y, 8, 8);
    }
  }
};

const MATERIALS: Record<string, { paint: Painter; tile: number }> = {
  floor: { paint: paintFloor, tile: 2 },
  wall: { paint: paintWall, tile: 2 },
  stone: { paint: paintStone, tile: 2 },
  crate: { paint: paintCrate, tile: 1 },
  metal: { paint: paintMetal, tile: 2 },
};

function makeTexture(paint: Painter, seed: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  paint(ctx, mulberry32(seed));

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestMipmapNearestFilter;
  return texture;
}

/** Maps abstract material ids from the map to their retro look. */
export function createMaterialLooks(): (id: string) => MaterialLook {
  const cache = new Map<string, MaterialLook>();
  return (id) => {
    let look = cache.get(id);
    if (!look) {
      const known = MATERIALS[id];
      look = {
        texture: makeTexture(known?.paint ?? paintMissing, cache.size + 1),
        tile: known?.tile ?? 1,
      };
      cache.set(id, look);
    }
    return look;
  };
}
