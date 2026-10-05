// What a fight leaves behind: marks on walls, chips, sparks, smoke, blood and
// flashes of light. All of it is decoration; none of it is known to the server.
import {
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PointLight,
  Vector3,
  type CanvasTexture,
} from 'three';
import constants from '@shared/constants.json';
import type { GameMap, Vec3 } from '../sim/map';
import { shotEnd, surfaceAt, WEAPON_RANGE, type Surface } from '../sim/ray';
import { Particles } from './particles';
import { pixelTexture } from './players';

const MAX_DECALS = 160;
const HOLE_SIZE = 0.22;
const SCORCH_SIZE = constants.rocket.splashRadius * 0.9;
const BLOOD_SIZE = 1.1;
const TRAIL_START = 2.5;
// Lights are costly, and the shader is rebuilt when their number changes: a fixed few.
const LIGHTS = 4;

type Rgb = readonly [number, number, number];

function rgb(hex: string): Rgb {
  const color = new Color(hex);
  return [color.r, color.g, color.b];
}

/** What flies off a surface of each material when it is hit. */
const CHIPS: Record<string, { colors: Rgb[]; sparks: number }> = {
  floor: { colors: [rgb('#4a4852'), rgb('#6a6874')], sparks: 1 },
  wall: { colors: [rgb('#803e30'), rgb('#3c3432'), rgb('#a05240')], sparks: 0 },
  stone: { colors: [rgb('#706e68'), rgb('#9a978f')], sparks: 1 },
  crate: { colors: [rgb('#96683a'), rgb('#6e4a26'), rgb('#b88752')], sparks: 0 },
  metal: { colors: [rgb('#546274')], sparks: 6 },
};
const DEFAULT_CHIPS = { colors: [rgb('#777777')], sparks: 1 };
const SPARK = [rgb('#fff6c8'), rgb('#ffcf5a'), rgb('#ff8a3a')];
const BLOOD = [rgb('#b3121e'), rgb('#7a0c14'), rgb('#e0352b')];
const FIRE = [rgb('#fff6c8'), rgb('#ffcf5a'), rgb('#ff7a2e'), rgb('#b3371f')];
const SMOKE = [rgb('#3a3836'), rgb('#56524e'), rgb('#6e6a66')];
const DUST = [rgb('#8d8a86'), rgb('#a7a39c')];
const BRASS = rgb('#d6a94a');

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T;
}

function spread(amount: number): number {
  return (Math.random() - 0.5) * 2 * amount;
}

/** A blotch with ragged edges, darker towards the middle. */
function blotch(size: number, colors: string[], density: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  // Fixed pattern, so the marks look the same on every load.
  let seed = size * 7919;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half;
      if (distance > 1 || random() > density * (1.25 - distance)) continue;
      ctx.fillStyle =
        colors[Math.min(Math.floor(distance * colors.length), colors.length - 1)] ?? '';
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return pixelTexture(canvas);
}

function decalMaterial(map: CanvasTexture, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({
    map,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
}

interface Flash {
  light: PointLight;
  peak: number;
  age: number;
  life: number;
}

export class Effects {
  readonly group = new Group();
  private readonly debris = new Particles({
    max: 1500,
    size: 0.07,
    gravity: 18,
    drag: 0.6,
    bounce: true,
    opacity: 1,
  });
  private readonly glow = new Particles({
    max: 900,
    size: 0.06,
    gravity: 6,
    drag: 2.5,
    bounce: true,
    opacity: 1,
  });
  private readonly smoke = new Particles({
    max: 500,
    size: 0.42,
    gravity: -0.9,
    drag: 1.8,
    bounce: false,
    opacity: 0.32,
  });
  private readonly dust = new Particles({
    max: 400,
    size: 0.16,
    gravity: -0.4,
    drag: 2.5,
    bounce: false,
    opacity: 0.3,
  });
  private readonly plane = new PlaneGeometry(1, 1);
  private readonly hole = decalMaterial(blotch(8, ['#0c0b0d', '#1c1a1d', '#2c2a2e'], 1.1), 0.9);
  private readonly scorch = decalMaterial(blotch(24, ['#0c0b0d', '#151316', '#221f22'], 0.9), 0.8);
  private readonly blood = decalMaterial(blotch(16, ['#7a0c14', '#99111c', '#b3121e'], 0.8), 0.9);
  private decals: Mesh[] = [];
  private readonly flashes: Flash[] = [];
  private nextFlash = 0;

  constructor(private readonly map: GameMap) {
    // Sparks and fire are not dimmed by the fog.
    this.glow.points.material.fog = false;
    this.group.add(this.debris.points, this.glow.points, this.smoke.points, this.dust.points);
    for (let i = 0; i < LIGHTS; i++) {
      const light = new PointLight('#ffffff', 0, 1, 2);
      this.group.add(light);
      this.flashes.push({ light, peak: 0, age: 1, life: 1 });
    }
  }

  /**
   * A shot that flew from `from` has stopped at `to`: a hole and chips if that is a
   * surface of the map, blood if it stopped in the air, i.e. in a player.
   * `power` scales the amount, 1 for a bullet.
   */
  impact(from: Vec3, to: Vec3, power = 1): void {
    const surface = surfaceAt(this.map, to);
    if (!surface) {
      const flown = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      if (flown < WEAPON_RANGE - 1) this.burst(to, BLOOD, 8 * power, 3.5, this.debris, 0.9);
      return;
    }
    const [nx, ny, nz] = surface.normal;
    const chips = CHIPS[surface.block.material] ?? DEFAULT_CHIPS;
    this.addDecal(to, surface, HOLE_SIZE * (0.8 + 0.4 * power), this.hole);
    for (let i = 0; i < 5 * power; i++) {
      const speed = 1.5 + Math.random() * 3;
      this.debris.emit(
        to[0] + nx * 0.03,
        to[1] + ny * 0.03,
        to[2] + nz * 0.03,
        nx * speed + spread(1.6),
        ny * speed + spread(1.6) + 1.2,
        nz * speed + spread(1.6),
        pick(chips.colors),
        0.5 + Math.random() * 0.7,
      );
    }
    for (let i = 0; i < chips.sparks * power; i++) {
      const speed = 3 + Math.random() * 5;
      this.glow.emit(
        to[0] + nx * 0.03,
        to[1] + ny * 0.03,
        to[2] + nz * 0.03,
        nx * speed + spread(3),
        ny * speed + spread(3),
        nz * speed + spread(3),
        pick(SPARK),
        0.15 + Math.random() * 0.3,
      );
    }
    for (let i = 0; i < 2 * power; i++) {
      this.dust.emit(
        to[0] + nx * 0.1,
        to[1] + ny * 0.1,
        to[2] + nz * 0.1,
        nx * 0.8 + spread(0.4),
        ny * 0.8 + spread(0.4),
        nz * 0.8 + spread(0.4),
        pick(DUST),
        0.4 + Math.random() * 0.3,
      );
    }
  }

  /** A rocket has gone off at `pos`. */
  blast(pos: Vec3): void {
    this.flash(pos, '#ffb060', 260, 20, 0.4);
    const surface = surfaceAt(this.map, pos);
    if (surface) {
      this.addDecal(pos, surface, SCORCH_SIZE, this.scorch);
      const chips = CHIPS[surface.block.material] ?? DEFAULT_CHIPS;
      this.burst(pos, chips.colors, 40, 9, this.debris, 1.6);
    }
    this.burst(pos, FIRE, 70, 10, this.glow, 0.55);
    for (let i = 0; i < 26; i++) {
      this.smoke.emit(
        pos[0] + spread(0.8),
        pos[1] + spread(0.5) + 0.3,
        pos[2] + spread(0.8),
        spread(2.5),
        Math.random() * 2,
        spread(2.5),
        pick(SMOKE),
        0.9 + Math.random() * 0.9,
      );
    }
  }

  /** A weapon has fired at `pos`: a flash of light and, for `casing`, a spent case. */
  muzzle(pos: Vec3, color: string, casing: Vec3 | null): void {
    this.flash(pos, color, 26, 9, 0.07);
    if (!casing) return;
    this.debris.emit(
      pos[0],
      pos[1] - 0.1,
      pos[2],
      casing[0] * 2.2 + spread(0.4),
      2.4 + Math.random(),
      casing[2] * 2.2 + spread(0.4),
      BRASS,
      1.6,
    );
  }

  /** A player has died at `pos` (their feet). */
  gore(pos: Vec3): void {
    const chest: Vec3 = [pos[0], pos[1] + 1, pos[2]];
    this.burst(chest, BLOOD, 60, 5.5, this.debris, 1.4);
    // A pool on whatever is under them.
    const ground = shotEnd(this.map, chest, [0, -1, 0], []);
    const surface = surfaceAt(this.map, ground);
    if (surface && chest[1] - ground[1] < 4) this.addDecal(ground, surface, BLOOD_SIZE, this.blood);
  }

  /** The trail of a rail: motes hanging along the line. */
  trail(from: Vec3, to: Vec3, color: string): void {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const steps = Math.min(Math.ceil(length / 0.35), 300);
    const tint = rgb(color);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Not right in front of the shooter, where a mote would fill the view.
      if (t * length < TRAIL_START) continue;
      this.glow.emit(
        from[0] + (to[0] - from[0]) * t + spread(0.04),
        from[1] + (to[1] - from[1]) * t + spread(0.04),
        from[2] + (to[2] - from[2]) * t + spread(0.04),
        spread(0.25),
        0.9 + spread(0.25),
        spread(0.25),
        tint,
        0.45 + Math.random() * 0.4,
      );
    }
  }

  /** Something made of `colors` has fallen apart at `pos`. */
  shatter(pos: Vec3, colors: readonly string[], size: number): void {
    const palette = colors.map(rgb);
    for (let i = 0; i < 34; i++) {
      this.debris.emit(
        pos[0] + spread(size * 0.5),
        pos[1] + spread(size * 0.5),
        pos[2] + spread(size * 0.5),
        spread(4),
        1 + Math.random() * 4.5,
        spread(4),
        pick(palette),
        0.9 + Math.random() * 1.2,
      );
    }
    for (let i = 0; i < 12; i++) {
      this.dust.emit(
        pos[0] + spread(0.3),
        pos[1],
        pos[2] + spread(0.3),
        spread(1),
        0.6,
        spread(1),
        pick(DUST),
        0.8,
      );
    }
  }

  update(dt: number): void {
    this.debris.update(dt);
    this.glow.update(dt);
    this.smoke.update(dt);
    this.dust.update(dt);
    for (const flash of this.flashes) {
      if (flash.age >= flash.life) continue;
      flash.age += dt;
      flash.light.intensity = flash.peak * Math.max(1 - flash.age / flash.life, 0);
    }
  }

  private flash(pos: Vec3, color: string, intensity: number, distance: number, life: number): void {
    // Take the next light in turn; with only a few, the oldest flash is nearly over anyway.
    const flash = this.flashes[this.nextFlash++ % this.flashes.length];
    if (!flash) return;
    flash.light.color.set(color);
    flash.light.position.set(pos[0], pos[1], pos[2]);
    flash.light.distance = distance;
    flash.light.intensity = intensity;
    flash.peak = intensity;
    flash.age = 0;
    flash.life = life;
  }

  private burst(
    pos: Vec3,
    colors: readonly Rgb[],
    count: number,
    speed: number,
    into: Particles,
    life: number,
  ): void {
    for (let i = 0; i < count; i++) {
      into.emit(
        pos[0],
        pos[1],
        pos[2],
        spread(speed),
        spread(speed) + speed * 0.35,
        spread(speed),
        pick(colors),
        life * (0.5 + Math.random() * 0.5),
      );
    }
  }

  private addDecal(point: Vec3, surface: Surface, size: number, material: MeshBasicMaterial): void {
    const [nx, ny, nz] = surface.normal;
    // A mark must not hang over the edge of the face it is on.
    const side = Math.min(size, surface.room * 2);
    if (side < 0.1) return;
    const mesh = new Mesh(this.plane, material);
    // Later marks sit a hair above earlier ones, so they do not flicker through each other.
    const lift = 0.004 + (this.decals.length % 16) * 0.0004;
    mesh.position.set(point[0] + nx * lift, point[1] + ny * lift, point[2] + nz * lift);
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(nx, ny, nz));
    mesh.rotateZ((Math.floor(Math.random() * 4) * Math.PI) / 2);
    mesh.scale.set(side, side, 1);
    this.group.add(mesh);
    this.decals.push(mesh);
    while (this.decals.length > MAX_DECALS) {
      const oldest = this.decals.shift();
      if (oldest) this.group.remove(oldest);
    }
  }
}
