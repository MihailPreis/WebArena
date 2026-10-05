import {
  BoxGeometry,
  BufferAttribute,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MapProp, Vec3 } from '../sim/map';
import { rayBox } from '../sim/ray';
import { MISSING_PROP, PROP_MODELS, type PropPart } from './propModels';
import { FACE_SHADE } from './world';

// A broken prop is back after this long, once nobody stands in its place.
const RESTORE_S = 45;

export interface Broken {
  /** Middle of the prop. */
  pos: Vec3;
  colors: string[];
  /** Its largest dimension, in metres. */
  size: number;
}

interface Prop {
  root: Group;
  min: Vec3;
  max: Vec3;
  colors: string[];
  /** Seconds until it is whole again; 0 while it stands. */
  brokenFor: number;
}

function partsGeometry(parts: PropPart[]): BufferGeometry | null {
  if (parts.length === 0) return null;
  const boxes = parts.map((part) => {
    const size = part.max.map((value, axis) => value - (part.min[axis] ?? 0)) as Vec3;
    const geometry = new BoxGeometry(...size);
    geometry.translate(
      (part.min[0] + part.max[0]) / 2,
      (part.min[1] + part.max[1]) / 2,
      (part.min[2] + part.max[2]) / 2,
    );
    const { r, g, b } = new Color(part.color);
    const count = geometry.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // The same fixed shading per face as the blocks of the map have.
      const shade = part.glow ? 1 : (FACE_SHADE[Math.floor(i / 4)] ?? 1);
      colors.set([r * shade, g * shade, b * shade], i * 3);
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    return geometry;
  });
  return mergeGeometries(boxes);
}

/**
 * Decorative clutter. It breaks when shot, caught by a blast or run into, and is
 * back after a while. Purely local: it stops neither bullets nor players, and the
 * server does not know it exists.
 */
export class Props {
  readonly group = new Group();
  private readonly props: Prop[] = [];
  private readonly lit = new MeshLambertMaterial({ vertexColors: true });
  private readonly glowing = new MeshBasicMaterial({ vertexColors: true });
  private readonly models = new Map<string, (BufferGeometry | null)[]>();

  constructor(
    props: readonly MapProp[],
    private readonly onBreak: (broken: Broken) => void,
  ) {
    for (const prop of props) {
      const parts = PROP_MODELS[prop.type] ?? MISSING_PROP;
      let model = this.models.get(prop.type);
      if (!model) {
        model = [
          partsGeometry(parts.filter((part) => !part.glow)),
          partsGeometry(parts.filter((part) => part.glow)),
        ];
        this.models.set(prop.type, model);
      }
      const root = new Group();
      if (model[0]) root.add(new Mesh(model[0], this.lit));
      if (model[1]) root.add(new Mesh(model[1], this.glowing));
      root.position.set(...prop.position);
      root.rotation.y = prop.yaw;
      this.group.add(root);

      // Turned any way round, the prop fits into a square of its largest reach.
      const reach = Math.max(
        ...parts.flatMap((p) => [p.min[0], p.max[0], p.min[2], p.max[2]].map(Math.abs)),
      );
      const height = Math.max(...parts.map((part) => part.max[1]));
      const [x, y, z] = prop.position;
      this.props.push({
        root,
        min: [x - reach, y, z - reach],
        max: [x + reach, y + height, z + reach],
        colors: [...new Set(parts.map((part) => part.color))],
        brokenFor: 0,
      });
    }
  }

  /** Breaks what a shot from `from` to `to` passed through. */
  hitSegment(from: Vec3, to: Vec3): void {
    const delta: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const length = Math.hypot(...delta);
    if (length === 0) return;
    const direction = delta.map((value) => value / length) as Vec3;
    for (const prop of this.props) {
      if (prop.brokenFor > 0) continue;
      const distance = rayBox(from, direction, prop.min, prop.max);
      if (distance !== null && distance <= length) this.break(prop);
    }
  }

  /** Breaks everything within `radius` of `pos`. */
  hitSphere(pos: Vec3, radius: number): void {
    for (const prop of this.props) {
      if (prop.brokenFor > 0) continue;
      const gap = Math.hypot(
        ...pos.map((value, axis) =>
          Math.max((prop.min[axis] ?? 0) - value, 0, value - (prop.max[axis] ?? 0)),
        ),
      );
      if (gap < radius) this.break(prop);
    }
  }

  /**
   * Call every frame with the boxes of all players: they knock over what they run
   * into, and nothing is put back where somebody stands.
   */
  update(dt: number, players: readonly { min: Vec3; max: Vec3 }[]): void {
    for (const prop of this.props) {
      const touched = players.some((box) =>
        box.min.every(
          (value, axis) =>
            value < (prop.max[axis] ?? 0) && (box.max[axis] ?? 0) > (prop.min[axis] ?? 0),
        ),
      );
      if (prop.brokenFor === 0) {
        if (touched) this.break(prop);
        continue;
      }
      prop.brokenFor = Math.max(prop.brokenFor - dt, touched ? 0.5 : 0);
      if (prop.brokenFor === 0) prop.root.visible = true;
    }
  }

  private break(prop: Prop): void {
    prop.brokenFor = RESTORE_S;
    prop.root.visible = false;
    const size = prop.max.map((value, axis) => value - (prop.min[axis] ?? 0)) as Vec3;
    this.onBreak({
      pos: [
        (prop.min[0] + prop.max[0]) / 2,
        (prop.min[1] + prop.max[1]) / 2,
        (prop.min[2] + prop.max[2]) / 2,
      ],
      colors: prop.colors,
      size: Math.max(...size),
    });
  }
}
