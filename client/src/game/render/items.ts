// Things lying on the map: placeholder pixel art painted in code, like the players.
import constants from '@shared/constants.json';
import {
  AdditiveBlending,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Sprite,
  SpriteMaterial,
} from 'three';
import type { MapItem } from '../sim/map';
import { QUAD_COLOR, WEAPON_COLORS } from './colors';
import { pixelTexture } from './players';

const SIZE = 16;
const WIDTH = 0.75;
// How high over the floor an item hovers, and how far it bobs up and down.
const HOVER = 0.35;
const BOB = 0.1;
const BOB_RATE = 2.4;
// The glow behind an item and the ring under it, relative to the item's width.
const HALO_SCALE = 2.3;
const RING_SCALE = 1.5;
// Colour of the glow for the kinds that are not tied to a weapon.
const KIND_COLORS: Record<string, string> = {
  health: '#ff5a4d',
  armor: '#ffcf5a',
  quad: QUAD_COLOR,
};

const TYPES: Record<string, { kind: string; weapon: number; amount: number }> =
  constants.items.types;

type Rect = (x: number, y: number, w: number, h: number, style: string) => void;

function paintWeapon(rect: Rect, weapon: number, color: string): void {
  const dark = '#2b2f36';
  if (weapon === 2) {
    // A fat tube.
    rect(1, 5, 14, 5, color);
    rect(1, 6, 14, 1, '#ffffff');
    rect(0, 4, 2, 7, dark);
    rect(9, 10, 3, 4, dark);
  } else if (weapon === 3) {
    // Long and thin, with a glowing rail.
    rect(0, 7, 16, 2, dark);
    rect(2, 6, 12, 1, color);
    rect(2, 9, 12, 1, color);
    rect(10, 10, 3, 4, dark);
  } else {
    rect(1, 6, 13, weapon === 1 ? 4 : 3, color);
    rect(1, 6, 13, 1, '#ffffff');
    rect(11, 9, 4, 5, dark);
    rect(5, 9, 2, 3, dark);
  }
}

function paint(type: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  const rect: Rect = (x, y, w, h, style) => {
    ctx.fillStyle = style;
    ctx.fillRect(x, y, w, h);
  };
  const spec = TYPES[type];
  const color = WEAPON_COLORS[spec?.weapon ?? 0] ?? '#ffffff';

  switch (spec?.kind) {
    case 'weapon':
      paintWeapon(rect, spec.weapon, color);
      break;
    case 'ammo':
      rect(3, 6, 10, 9, '#33373f');
      rect(4, 5, 8, 1, '#565d69');
      rect(3, 9, 10, 3, color);
      break;
    case 'health': {
      // The bigger kit is gold.
      const large = spec.amount > 25;
      rect(2, 3, 12, 12, large ? '#ffcf5a' : '#f4f1ea');
      rect(7, 5, 2, 8, '#e0352b');
      rect(4, 8, 8, 2, '#e0352b');
      break;
    }
    case 'armor': {
      const heavy = spec.amount > 50;
      const plate = heavy ? '#e0352b' : '#feca57';
      rect(3, 2, 10, 8, plate);
      rect(4, 10, 8, 2, plate);
      rect(6, 12, 4, 2, plate);
      rect(5, 4, 2, 5, '#ffffff');
      break;
    }
    default:
      // The damage booster: a diamond.
      for (let row = 0; row < 7; row++) {
        rect(7 - row, 1 + row, 2 + row * 2, 1, QUAD_COLOR);
        rect(7 - row, 14 - row, 2 + row * 2, 1, QUAD_COLOR);
      }
      rect(6, 6, 4, 4, '#ffffff');
  }
  return canvas;
}

/** A soft round blob, or with `hollow` a ring, in coarse white pixels to be tinted. */
function paintGlow(hollow: boolean): HTMLCanvasElement {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.fillStyle = '#ffffff';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const alpha = hollow ? 1 - Math.abs(distance - 0.8) * 6 : 1 - distance;
      ctx.globalAlpha = Math.min(Math.max(alpha, 0), 1);
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

/** Items of the map as camera-facing sprites; those picked up are hidden until they return. */
export class ItemSprites {
  readonly group = new Group();
  private readonly items: { sprite: Sprite; halo: Sprite; ring: Mesh; y: number }[];
  // One material per colour, so that all the glows of a colour pulse together.
  private readonly glows = new Map<string, { halo: SpriteMaterial; ring: MeshBasicMaterial }>();
  private readonly haloMap = pixelTexture(paintGlow(false));
  private readonly ringMap = pixelTexture(paintGlow(true));
  private readonly plane = new PlaneGeometry(1, 1);
  private time = 0;

  constructor(items: readonly MapItem[]) {
    this.items = items.map((item) => {
      const spec = TYPES[item.type];
      const sprite = new Sprite(
        new SpriteMaterial({ map: pixelTexture(paint(item.type)), alphaTest: 0.5 }),
      );
      const scale = spec?.kind === 'quad' ? WIDTH * 1.3 : WIDTH;
      const [x, y, z] = item.position;
      sprite.center.set(0.5, 0);
      sprite.scale.set(scale, scale, 1);
      sprite.position.set(x, y + HOVER, z);

      // A glow behind the item and a ring on the floor under it set pickups apart
      // from the clutter of the map.
      const color = KIND_COLORS[spec?.kind ?? ''] ?? WEAPON_COLORS[spec?.weapon ?? 0] ?? '#ffffff';
      const glow = this.glow(color);
      const halo = new Sprite(glow.halo);
      halo.scale.set(scale * HALO_SCALE, scale * HALO_SCALE, 1);
      halo.position.set(x, y + HOVER + scale / 2, z);
      const ring = new Mesh(this.plane, glow.ring);
      ring.rotation.x = -Math.PI / 2;
      ring.scale.set(scale * RING_SCALE, scale * RING_SCALE, 1);
      ring.position.set(x, y + 0.03, z);

      this.group.add(halo, ring, sprite);
      return { sprite, halo, ring, y: y + HOVER };
    });
  }

  /** Bit `i` of `mask` is set while item `i` is there to be picked up. */
  setPresent(mask: number): void {
    this.items.forEach(({ sprite, halo, ring }, index) => {
      sprite.visible = halo.visible = ring.visible = ((mask >> index) & 1) === 1;
    });
  }

  update(dt: number): void {
    this.time += dt;
    this.items.forEach(({ sprite, halo, y }, index) => {
      // The index puts neighbours out of step.
      const lift = Math.sin(this.time * BOB_RATE + index) * BOB;
      sprite.position.y = y + lift;
      halo.position.y = y + lift + sprite.scale.y / 2;
    });
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 3);
    for (const { halo, ring } of this.glows.values()) {
      halo.opacity = 0.3 + 0.15 * pulse;
      ring.opacity = 0.45 + 0.3 * pulse;
    }
  }

  private glow(color: string): { halo: SpriteMaterial; ring: MeshBasicMaterial } {
    let glow = this.glows.get(color);
    if (!glow) {
      const shared = { color, transparent: true, blending: AdditiveBlending, depthWrite: false };
      glow = {
        halo: new SpriteMaterial({ ...shared, map: this.haloMap, fog: false }),
        ring: new MeshBasicMaterial({ ...shared, map: this.ringMap }),
      };
      this.glows.set(color, glow);
    }
    return glow;
  }
}
