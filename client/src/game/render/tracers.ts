import { BufferGeometry, Group, Line, LineBasicMaterial, Vector3 } from 'three';
import type { Vec3 } from '../sim/map';

const BULLET: TracerStyle = { color: '#ffe9a0', life: 0.09 };

export interface TracerStyle {
  color: string;
  /** Seconds the line stays visible. */
  life: number;
}

interface Tracer {
  line: Line<BufferGeometry, LineBasicMaterial>;
  age: number;
  life: number;
}

/** Short-lived lines that show the path of a shot. */
export class Tracers {
  readonly group = new Group();
  private tracers: Tracer[] = [];

  add(from: Vec3, to: Vec3, style: TracerStyle = BULLET): void {
    const geometry = new BufferGeometry().setFromPoints([new Vector3(...from), new Vector3(...to)]);
    const material = new LineBasicMaterial({ color: style.color, transparent: true, fog: false });
    const line = new Line(geometry, material);
    this.group.add(line);
    this.tracers.push({ line, age: 0, life: style.life });
  }

  update(dt: number): void {
    this.tracers = this.tracers.filter((tracer) => {
      tracer.age += dt;
      if (tracer.age < tracer.life) {
        tracer.line.material.opacity = 1 - tracer.age / tracer.life;
        return true;
      }
      this.group.remove(tracer.line);
      tracer.line.geometry.dispose();
      tracer.line.material.dispose();
      return false;
    });
  }
}
