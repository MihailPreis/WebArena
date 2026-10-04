import { Color, Fog, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import type { GameMap, Vec3 } from '../sim/map';
import { buildSky } from './sky';
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
  render(view: View): void;
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
    render(view) {
      camera.position.set(view.eye[0], view.eye[1], view.eye[2]);
      camera.rotation.set(view.pitch, view.yaw, 0);
      sky.position.copy(camera.position);
      renderer.render(scene, camera);
    },
  };
}
