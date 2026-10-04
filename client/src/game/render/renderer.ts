import { Color, Fog, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import type { GameMap, Vec3 } from '../sim/map';
import { PlayerSprites, type RenderPlayer } from './players';
import { buildSky } from './sky';
import { Tracers } from './tracers';
import { buildWorld } from './world';

// The scene is drawn at roughly this many rows and upscaled without smoothing.
const TARGET_HEIGHT = 400;
const FOG_COLOR = '#3a2440';
const VERTICAL_FOV = 75;

export interface View {
  eye: Vec3;
  yaw: number;
  pitch: number;
}

export interface GameRenderer {
  /** `dt` is the time since the previous frame, in seconds. */
  render(view: View, players: readonly RenderPlayer[], dt: number): void;
  /** Shows the path of a shot for a moment. */
  addTracer(from: Vec3, to: Vec3): void;
  /**
   * The point in the world that appears at screen position (x, y), in CSS pixels,
   * `distance` metres from the camera as of the last rendered frame.
   */
  screenToWorld(x: number, y: number, distance: number): Vec3;
  /**
   * Where a point of the world appears on screen, in CSS pixels, as of the last
   * rendered frame; null when the point is behind the camera.
   */
  worldToScreen(pos: Vec3): { x: number; y: number } | null;
  resize(): void;
}

/** Everything visual lives behind this interface; it only reads game state. */
export function createRenderer(canvas: HTMLCanvasElement, map: GameMap): GameRenderer {
  const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);

  const scene = new Scene();
  scene.background = new Color(FOG_COLOR);
  scene.fog = new Fog(FOG_COLOR, 14, 70);
  scene.add(buildWorld(map));
  const sky = buildSky(FOG_COLOR);
  scene.add(sky);
  const sprites = new PlayerSprites();
  scene.add(sprites.group);
  const tracers = new Tracers();
  scene.add(tracers.group);

  const camera = new PerspectiveCamera(VERTICAL_FOV, 1, 0.05, 200);
  camera.rotation.order = 'YXZ';

  function resize(): void {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    // Whole-number scale keeps every game pixel the same size on screen.
    const devicePixels = height * window.devicePixelRatio;
    const scale = Math.max(1, Math.round(devicePixels / TARGET_HEIGHT));
    renderer.setSize(
      Math.ceil((width * window.devicePixelRatio) / scale),
      Math.ceil(devicePixels / scale),
      false,
    );
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  resize();

  return {
    resize,
    addTracer(from, to) {
      tracers.add(from, to);
    },
    screenToWorld(x, y, distance) {
      const rect = canvas.getBoundingClientRect();
      const point = new Vector3(
        ((x - rect.left) / rect.width) * 2 - 1,
        -((y - rect.top) / rect.height) * 2 + 1,
        0.5,
      ).unproject(camera);
      const direction = point.sub(camera.position).normalize();
      const world = camera.position.clone().addScaledVector(direction, distance);
      return [world.x, world.y, world.z];
    },
    worldToScreen(pos) {
      const point = new Vector3(pos[0], pos[1], pos[2]).project(camera);
      // Past the far plane in clip space means behind the camera.
      if (point.z > 1) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + ((point.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - point.y) / 2) * rect.height,
      };
    },
    render(view, players, dt) {
      sprites.update(players, view.eye);
      tracers.update(dt);
      camera.position.set(view.eye[0], view.eye[1], view.eye[2]);
      camera.rotation.set(view.pitch, view.yaw, 0);
      sky.position.copy(camera.position);
      renderer.render(scene, camera);
    },
  };
}
