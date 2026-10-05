import { CanvasTexture, Group, Sprite, SpriteMaterial } from 'three';
import constants from '@shared/constants.json';
import type { Vec3 } from '../sim/map';
import { pixelTexture } from './players';

const SPEED = constants.rocket.speed;
const BLAST_SIZE = constants.rocket.splashRadius * 1.6;
const BLAST_S = 0.35;
const ROCKET_SIZE = 0.4;
const SMOKE_INTERVAL_S = 0.025;
const SMOKE_S = 0.45;
const SMOKE_SIZE = 0.35;

function paint(size: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  draw(ctx);
  return pixelTexture(canvas);
}

/** Concentric blocky rings, from the outside in. */
function rings(ctx: CanvasRenderingContext2D, size: number, colors: string[]): void {
  colors.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(i + 1, i, size - 2 * i - 2, size - 2 * i);
    ctx.fillRect(i, i + 1, size - 2 * i, size - 2 * i - 2);
  });
}

interface Rocket {
  sprite: Sprite;
  from: Vec3;
  dir: Vec3;
  travelled: number;
  /** Metres to the nearest wall along the path: the rocket is never drawn beyond it. */
  limit: number;
  /** The rocket is not drawn before it has flown this far. */
  hiddenUntil: number;
  smokeIn: number;
}

interface Fading {
  sprite: Sprite;
  age: number;
}

/** Rockets in flight, their smoke and their blasts. Purely visual: the server decides hits. */
export class Projectiles {
  readonly group = new Group();
  private readonly rocketMap = paint(8, (ctx) => rings(ctx, 8, ['#ff7a2e', '#ffcf5a', '#fff6c8']));
  private readonly smokeMap = paint(4, (ctx) => rings(ctx, 4, ['#8d8a86']));
  private readonly blastMap = paint(16, (ctx) =>
    rings(ctx, 16, ['#b3371f', '#ff5a2e', '#ff8a3a', '#ffcf5a', '#fff6c8']),
  );
  private readonly rockets = new Map<number, Rocket>();
  private smoke: Fading[] = [];
  private blasts: Fading[] = [];

  /** `skip` metres of the flight are not drawn: the player's own rocket starts at the eyes. */
  launch(key: number, from: Vec3, dir: Vec3, limit: number, skip = 0): void {
    const sprite = new Sprite(
      new SpriteMaterial({ map: this.rocketMap, alphaTest: 0.5, fog: false }),
    );
    sprite.scale.set(ROCKET_SIZE, ROCKET_SIZE, 1);
    sprite.visible = false;
    this.group.add(sprite);
    this.rockets.set(key, {
      sprite,
      from,
      dir,
      travelled: 0,
      limit,
      hiddenUntil: skip,
      smokeIn: 0,
    });
  }

  /** Gives a rocket launched under a temporary key the number the server knows it by. */
  rename(from: number, to: number): void {
    const rocket = this.rockets.get(from);
    if (!rocket) return;
    this.rockets.delete(from);
    this.rockets.set(to, rocket);
  }

  /** Removes the rocket, if it is still flying, and shows the blast. */
  explode(key: number, pos: Vec3): void {
    this.remove(key);
    const sprite = new Sprite(
      new SpriteMaterial({ map: this.blastMap, transparent: true, depthWrite: false, fog: false }),
    );
    sprite.position.set(pos[0], pos[1], pos[2]);
    this.group.add(sprite);
    this.blasts.push({ sprite, age: 0 });
  }

  update(dt: number): void {
    for (const [key, rocket] of this.rockets) {
      rocket.travelled += SPEED * dt;
      if (rocket.travelled >= rocket.limit) {
        // The blast itself is shown when the server reports it.
        this.remove(key);
        continue;
      }
      const { sprite, from, dir, travelled } = rocket;
      sprite.position.set(
        from[0] + dir[0] * travelled,
        from[1] + dir[1] * travelled,
        from[2] + dir[2] * travelled,
      );
      sprite.visible = travelled >= rocket.hiddenUntil;
      rocket.smokeIn -= dt;
      if (sprite.visible && rocket.smokeIn <= 0) {
        rocket.smokeIn = SMOKE_INTERVAL_S;
        const puff = new Sprite(
          new SpriteMaterial({ map: this.smokeMap, transparent: true, depthWrite: false }),
        );
        puff.position.copy(sprite.position);
        this.group.add(puff);
        this.smoke.push({ sprite: puff, age: 0 });
      }
    }
    this.smoke = this.fade(this.smoke, dt, SMOKE_S, (puff, t) => {
      puff.sprite.material.opacity = 0.6 * (1 - t);
      puff.sprite.scale.setScalar(SMOKE_SIZE * (1 + t));
    });
    this.blasts = this.fade(this.blasts, dt, BLAST_S, (blast, t) => {
      blast.sprite.material.opacity = 1 - t * t;
      blast.sprite.scale.setScalar(BLAST_SIZE * (0.35 + 0.65 * Math.sqrt(t)));
    });
  }

  private remove(key: number): void {
    const rocket = this.rockets.get(key);
    if (!rocket) return;
    this.group.remove(rocket.sprite);
    rocket.sprite.material.dispose();
    this.rockets.delete(key);
  }

  /** Ages short-lived sprites; `show` gets the share of the lifetime that has passed. */
  private fade(
    list: Fading[],
    dt: number,
    life: number,
    show: (item: Fading, t: number) => void,
  ): Fading[] {
    return list.filter((item) => {
      item.age += dt;
      if (item.age < life) {
        show(item, item.age / life);
        return true;
      }
      this.group.remove(item.sprite);
      // The texture is shared; only the material is released.
      item.sprite.material.dispose();
      return false;
    });
  }
}
