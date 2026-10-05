import { BufferAttribute, BufferGeometry, Points, PointsMaterial } from 'three';

export interface ParticleOptions {
  /** How many can be alive at once; beyond that new ones replace old ones at random. */
  max: number;
  /** Side of the square, in metres. */
  size: number;
  /** Downward acceleration in m/s²; negative makes them rise. */
  gravity: number;
  /** Share of the speed lost per second. */
  drag: number;
  /** Whether they bounce off the ground level instead of sinking through it. */
  bounce: boolean;
  opacity: number;
}

/**
 * Many small squares drawn in one call: chips, sparks, smoke. They only fall, slow
 * down and fade; the level of the ground is all they know of the world.
 */
export class Particles {
  readonly points: Points<BufferGeometry, PointsMaterial>;
  private readonly position: Float32Array;
  private readonly color: Float32Array;
  private readonly velocity: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private count = 0;

  constructor(private readonly options: ParticleOptions) {
    const { max } = options;
    this.position = new Float32Array(max * 3);
    this.color = new Float32Array(max * 4);
    this.velocity = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.position, 3));
    geometry.setAttribute('color', new BufferAttribute(this.color, 4));
    geometry.setDrawRange(0, 0);
    this.points = new Points(
      geometry,
      new PointsMaterial({
        size: options.size,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
      }),
    );
    // The bounding sphere is never updated; they are cheap enough to always draw.
    this.points.frustumCulled = false;
  }

  /** `rgb` is in the renderer's working colour space; `life` is in seconds. */
  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    rgb: readonly [number, number, number],
    life: number,
  ): void {
    const { max } = this.options;
    const i = this.count < max ? this.count++ : Math.floor(Math.random() * max);
    this.position.set([x, y, z], i * 3);
    this.velocity.set([vx, vy, vz], i * 3);
    this.color.set([rgb[0], rgb[1], rgb[2], this.options.opacity], i * 4);
    this.age[i] = 0;
    this.life[i] = life;
  }

  update(dt: number): void {
    const { gravity, bounce, opacity } = this.options;
    const keep = Math.max(1 - this.options.drag * dt, 0);
    const { position, velocity, color, age, life } = this;
    for (let i = 0; i < this.count; i++) {
      const lived = (age[i] ?? 0) + dt;
      const span = life[i] ?? 0;
      if (lived >= span) {
        // The last one takes the place of the dead one.
        const last = --this.count;
        position.copyWithin(i * 3, last * 3, last * 3 + 3);
        velocity.copyWithin(i * 3, last * 3, last * 3 + 3);
        color.copyWithin(i * 4, last * 4, last * 4 + 4);
        age[i] = age[last] ?? 0;
        life[i] = life[last] ?? 0;
        i--;
        continue;
      }
      age[i] = lived;
      const p = i * 3;
      let vy = ((velocity[p + 1] ?? 0) - gravity * dt) * keep;
      let y = (position[p + 1] ?? 0) + vy * dt;
      if (bounce && y < 0.03 && vy < 0) {
        y = 0.03;
        vy *= -0.35;
        velocity[p] = (velocity[p] ?? 0) * 0.6;
        velocity[p + 2] = (velocity[p + 2] ?? 0) * 0.6;
      }
      velocity[p] = (velocity[p] ?? 0) * keep;
      velocity[p + 1] = vy;
      velocity[p + 2] = (velocity[p + 2] ?? 0) * keep;
      position[p] = (position[p] ?? 0) + (velocity[p] ?? 0) * dt;
      position[p + 1] = y;
      position[p + 2] = (position[p + 2] ?? 0) + (velocity[p + 2] ?? 0) * dt;
      // Fade out over the last third of the life.
      color[i * 4 + 3] = opacity * Math.min((1 - lived / span) * 3, 1);
    }
    const geometry = this.points.geometry;
    geometry.setDrawRange(0, this.count);
    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('color').needsUpdate = true;
  }
}
