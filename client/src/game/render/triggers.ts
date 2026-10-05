import {
  AdditiveBlending,
  BoxGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
} from 'three';
import type { GameMap } from '../sim/map';
import { pixelTexture } from './players';

const PAD_COLOR = '#ff8a3a';
const GATE_COLOR = '#48dbfb';

/** Rings closing in on the middle: "step here". */
function paintPad(): HTMLCanvasElement {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.fillStyle = '#2b1d14';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = PAD_COLOR;
  for (const inset of [0.5, 3.5, 6.5])
    ctx.strokeRect(inset, inset, size - 2 * inset, size - 2 * inset);
  return canvas;
}

/** Horizontal bands, for the shimmer of a gate. */
function paintGate(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  for (let y = 0; y < 16; y++) {
    ctx.fillStyle = GATE_COLOR;
    ctx.globalAlpha = y % 4 === 0 ? 0.95 : y % 2 === 0 ? 0.5 : 0.25;
    ctx.fillRect(0, y, 4, 1);
  }
  return canvas;
}

/** Jump pads and teleporters: glowing, so they are found at a glance. */
export class Triggers {
  readonly group = new Group();
  private readonly padGlow = new MeshBasicMaterial({
    color: PAD_COLOR,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
  private readonly gateMap = pixelTexture(paintGate());
  private readonly gate = new MeshBasicMaterial({
    map: this.gateMap,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
  private time = 0;

  constructor(map: GameMap) {
    const plate = new MeshBasicMaterial({ map: pixelTexture(paintPad()) });
    for (const pad of map.pads) {
      const [x0, y0, z0] = pad.min;
      const [x1, , z1] = pad.max;
      const top = new Mesh(new BoxGeometry(x1 - x0, 0.06, z1 - z0), plate);
      top.position.set((x0 + x1) / 2, y0 + 0.03, (z0 + z1) / 2);
      // A faint column of light over the plate.
      const beam = new Mesh(new BoxGeometry((x1 - x0) * 0.7, 1.4, (z1 - z0) * 0.7), this.padGlow);
      beam.position.set((x0 + x1) / 2, y0 + 0.75, (z0 + z1) / 2);
      this.group.add(top, beam);
    }
    const frame = new MeshBasicMaterial({ color: '#1d2b33' });
    for (const gate of map.teleporters) {
      const [x0, y0, z0] = gate.min;
      const [x1, y1, z1] = gate.max;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      // Two crossed sheets look like a column from any side.
      for (const turn of [0, Math.PI / 2]) {
        const sheet = new Mesh(new PlaneGeometry(x1 - x0, y1 - y0), this.gate);
        sheet.position.set(cx, (y0 + y1) / 2, cz);
        sheet.rotation.y = turn + Math.PI / 4;
        this.group.add(sheet);
      }
      const base = new Mesh(new BoxGeometry(x1 - x0 + 0.3, 0.08, z1 - z0 + 0.3), frame);
      base.position.set(cx, y0 + 0.04, cz);
      const cap = base.clone();
      cap.position.y = y1 + 0.04;
      this.group.add(base, cap);
    }
  }

  update(dt: number): void {
    this.time += dt;
    this.padGlow.opacity = 0.1 + 0.08 * Math.sin(this.time * 5);
    this.gate.opacity = 0.7 + 0.25 * Math.sin(this.time * 7);
    // The bands of a gate run upwards.
    this.gateMap.offset.y = -(this.time * 0.6) % 1;
  }
}
