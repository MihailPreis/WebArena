import { BufferGeometry, Group, Line, LineBasicMaterial, Vector3 } from 'three';
import type { Vec3 } from '../sim/map';

const LIFETIME_S = 0.09;

interface Tracer {
  line: Line<BufferGeometry, LineBasicMaterial>;
  age: number;
}

/** Short-lived lines that show the path of a shot. */
export class Tracers {
  readonly group = new Group();
  private tracers: Tracer[] = [];

  add(from: Vec3, to: Vec3): void {
    const geometry = new BufferGeometry().setFromPoints([new Vector3(...from), new Vector3(...to)]);
    const material = new LineBasicMaterial({ color: '#ffe9a0', transparent: true, fog: false });
    const line = new Line(geometry, material);
    this.group.add(line);
    this.tracers.push({ line, age: 0 });
  }

  update(dt: number): void {
    this.tracers = this.tracers.filter((tracer) => {
      tracer.age += dt;
      if (tracer.age < LIFETIME_S) {
        tracer.line.material.opacity = 1 - tracer.age / LIFETIME_S;
        return true;
      }
      this.group.remove(tracer.line);
      tracer.line.geometry.dispose();
      tracer.line.material.dispose();
      return false;
    });
  }
}
