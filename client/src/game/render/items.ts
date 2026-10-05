// Things lying on the map: placeholder pixel art painted in code, like the players.
import constants from '@shared/constants.json';
import { Group, Sprite, SpriteMaterial } from 'three';
import type { MapItem } from '../sim/map';
import { QUAD_COLOR, WEAPON_COLORS } from './colors';
import { pixelTexture } from './players';

const SIZE = 16;
const WIDTH = 0.75;
// How high over the floor an item hovers, and how far it bobs up and down.
const HOVER = 0.35;
const BOB = 0.1;
const BOB_RATE = 2.4;

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

/** Items of the map as camera-facing sprites; those picked up are hidden until they return. */
export class ItemSprites {
  readonly group = new Group();
  private readonly sprites: { sprite: Sprite; y: number }[];
  private time = 0;

  constructor(items: readonly MapItem[]) {
    this.sprites = items.map((item) => {
      const sprite = new Sprite(
        new SpriteMaterial({ map: pixelTexture(paint(item.type)), alphaTest: 0.5 }),
      );
      const scale = TYPES[item.type]?.kind === 'quad' ? WIDTH * 1.3 : WIDTH;
      sprite.center.set(0.5, 0);
      sprite.scale.set(scale, scale, 1);
      sprite.position.set(item.position[0], item.position[1] + HOVER, item.position[2]);
      this.group.add(sprite);
      return { sprite, y: item.position[1] + HOVER };
    });
  }

  /** Bit `i` of `mask` is set while item `i` is there to be picked up. */
  setPresent(mask: number): void {
    this.sprites.forEach(({ sprite }, index) => {
      sprite.visible = ((mask >> index) & 1) === 1;
    });
  }

  update(dt: number): void {
    this.time += dt;
    this.sprites.forEach(({ sprite, y }, index) => {
      // The index puts neighbours out of step.
      sprite.position.y = y + Math.sin(this.time * BOB_RATE + index) * BOB;
    });
  }
}
