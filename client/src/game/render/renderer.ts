import { AmbientLight, Color, Fog, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import constants from '@shared/constants.json';
import { PLAYER } from '../sim/constants';
import type { GameMap, Vec3 } from '../sim/map';
import { Effects } from './effects';
import { ItemSprites } from './items';
import { PlayerSprites, type RenderPlayer } from './players';
import { Projectiles } from './projectiles';
import { Props } from './props';
import { buildSky } from './sky';
import { Tracers, type TracerStyle } from './tracers';
import { Triggers } from './triggers';
import { buildWorld } from './world';

// The scene is drawn at roughly this many rows and upscaled without smoothing.
const TARGET_HEIGHT = 400;
const FOG_COLOR = '#3a2440';
const VERTICAL_FOV = 75;
// Colour of the light a shot throws around, by weapon; the rail's is cold.
const MUZZLE_LIGHT = ['#ffd9a0', '#ffd9a0', '#ffb060', '#8fe6ff'];
// How far below the camera the player's feet are taken to be, for knocking props over.
const EYE_TO_FEET = PLAYER.standEyeHeight;
// Nobody moves faster than this, in m/s; anything above is a change of place.
const MAX_SPEED = 60;
// How much wider the view gets at the peak of a dash, in degrees.
const RUSH_FOV = 9;

export interface View {
  eye: Vec3;
  yaw: number;
  pitch: number;
  /** Sense of speed, 0 to 1: widens the field of view during a dash. */
  rush: number;
}

export interface GameRenderer {
  /** `dt` is the time since the previous frame, in seconds. */
  render(view: View, players: readonly RenderPlayer[], dt: number): void;
  /**
   * Shows a shot that flew from `from` and stopped at `to`: its path, the mark it
   * left and what it knocked over on the way.
   */
  addShot(from: Vec3, to: Vec3, style?: TracerStyle): void;
  /**
   * Lights up the place a weapon fired from. `right` is the shooter's right-hand
   * direction, if a spent case should fly out that way.
   */
  muzzleFlash(pos: Vec3, weapon: number, right: Vec3 | null): void;
  /** A player has died at `pos` (their feet). */
  gore(pos: Vec3): void;
  /** Bit `i` of `mask` is set while item `i` of the map is there to be picked up. */
  setItems(mask: number): void;
  /**
   * Shows a rocket flying from `from` along `dir` for at most `limit` metres. The
   * first `skip` metres are not drawn. `key` names it for `bindRocket` and `explode`.
   */
  launchRocket(key: number, from: Vec3, dir: Vec3, limit: number, skip?: number): void;
  /** Renames a rocket once the server has given it a number. */
  bindRocket(key: number, number: number): void;
  /** Shows a blast and removes the rocket that caused it. */
  explode(key: number, pos: Vec3): void;
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

/**
 * Everything visual lives behind this interface; it only reads game state.
 * `onPropBroken` is told where a piece of decoration fell apart, for the sound of it.
 */
export function createRenderer(
  canvas: HTMLCanvasElement,
  map: GameMap,
  onPropBroken?: (pos: Vec3) => void,
): GameRenderer {
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
  const items = new ItemSprites(map.items);
  scene.add(items.group);
  const projectiles = new Projectiles();
  scene.add(projectiles.group);
  const triggers = new Triggers(map);
  scene.add(triggers.group);
  // Even light that shows surfaces exactly as painted; flashes add to it.
  scene.add(new AmbientLight('#ffffff', Math.PI));
  const effects = new Effects(map);
  scene.add(effects.group);
  const props = new Props(map.props, (broken) => {
    effects.shatter(broken.pos, broken.colors, broken.size);
    onPropBroken?.(broken.pos);
  });
  scene.add(props.group);

  const camera = new PerspectiveCamera(VERTICAL_FOV, 1, 0.05, 200);
  camera.rotation.order = 'YXZ';
  // Where each player was on the previous frame; the local player goes by the empty id.
  const lastSeen = new Map<string, Vec3>();

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
    addShot(from, to, style) {
      tracers.add(from, to, style);
      if (style?.trail) effects.trail(from, to, style.color);
      effects.impact(from, to, style?.power);
      props.hitSegment(from, to);
    },
    muzzleFlash(pos, weapon, right) {
      effects.muzzle(pos, MUZZLE_LIGHT[weapon] ?? '#ffd9a0', right);
    },
    gore(pos) {
      effects.gore(pos);
    },
    setItems(mask) {
      items.setPresent(mask);
    },
    launchRocket(key, from, dir, limit, skip) {
      projectiles.launch(key, from, dir, limit, skip);
    },
    bindRocket(key, number) {
      projectiles.rename(key, number);
    },
    explode(key, pos) {
      projectiles.explode(key, pos);
      effects.blast(pos);
      props.hitSphere(pos, constants.rocket.splashRadius);
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
      sprites.update(players, view.eye, dt);
      const fov = VERTICAL_FOV + RUSH_FOV * view.rush;
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      tracers.update(dt);
      items.update(dt);
      projectiles.update(dt);
      triggers.update(dt);
      effects.update(dt);
      const r = PLAYER.halfWidth;
      const feet = view.eye[1] - EYE_TO_FEET;
      const bodies = [
        { id: '', pos: [view.eye[0], feet, view.eye[2]] as Vec3, height: EYE_TO_FEET },
        ...players.map(({ id, pos, crouched }) => ({
          id,
          pos,
          height: crouched ? PLAYER.crouchHeight : PLAYER.standHeight,
        })),
      ];
      props.update(
        dt,
        bodies.map(({ id, pos, height }) => {
          // Speed is taken from how far the player has moved since the last frame.
          const before = lastSeen.get(id);
          const moved = before
            ? Math.hypot(...pos.map((value, axis) => value - (before[axis] ?? 0)))
            : 0;
          const speed = dt > 0 ? moved / dt : 0;
          return {
            min: [pos[0] - r, pos[1], pos[2] - r] as Vec3,
            max: [pos[0] + r, pos[1] + height, pos[2] + r] as Vec3,
            // A jump across the map is a respawn or a teleporter, not a charge.
            speed: speed > MAX_SPEED ? 0 : speed,
          };
        }),
      );
      lastSeen.clear();
      for (const { id, pos } of bodies) lastSeen.set(id, pos);
      camera.position.set(view.eye[0], view.eye[1], view.eye[2]);
      camera.rotation.set(view.pitch, view.yaw, 0);
      sky.position.copy(camera.position);
      renderer.render(scene, camera);
    },
  };
}
