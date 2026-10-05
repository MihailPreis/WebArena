import { CanvasTexture, Group, NearestFilter, Sprite, SpriteMaterial, SRGBColorSpace } from 'three';
import { PLAYER } from '../sim/constants';
import type { Vec3 } from '../sim/map';
import { QUAD_COLOR } from './colors';
import { FRAME_COUNT, paintNameTag, paintPlayerAtlas } from './playerSprite';

const SPRITE_WIDTH = 0.9;
const NAME_HEIGHT = 0.36;
const NAME_GAP = 0.15;
// A dashing player leaves fading copies of the sprite behind.
const GHOST_INTERVAL_S = 0.03;
const GHOST_LIFE_S = 0.28;
const GHOST_OPACITY = 0.5;

export interface RenderPlayer {
  id: string;
  name: string;
  /** Colour of the body and of the name tag. */
  color: string;
  /** Colour of sleeves and details, if different from the body. */
  accent: string | null;
  /** Feet position. */
  pos: Vec3;
  yaw: number;
  crouched: boolean;
  /** Whether the name floats over the player in the world. */
  nameTag: boolean;
  dashing: boolean;
  /** Carries the damage booster: the sprite is tinted. */
  quad: boolean;
}

interface Entry {
  name: string;
  color: string;
  accent: string | null;
  body: Sprite;
  tag: Sprite;
  /** Seconds until the next ghost may be left behind. */
  ghostIn: number;
}

interface Ghost {
  sprite: Sprite;
  age: number;
}

export function pixelTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** Other players, drawn as camera-facing sprites that show the side the camera sees. */
export class PlayerSprites {
  readonly group = new Group();
  private readonly entries = new Map<string, Entry>();
  private readonly ghosts: Ghost[] = [];

  /** `dt` is the time since the previous frame, in seconds. */
  update(players: readonly RenderPlayer[], camera: Vec3, dt: number): void {
    this.fadeGhosts(dt);
    const seen = new Set<string>();
    for (const player of players) {
      seen.add(player.id);
      let entry = this.entries.get(player.id);
      if (
        entry &&
        (entry.name !== player.name ||
          entry.color !== player.color ||
          entry.accent !== player.accent)
      ) {
        this.remove(player.id, entry);
        entry = undefined;
      }
      if (!entry) {
        entry = this.create(player);
        this.entries.set(player.id, entry);
      }

      const [x, y, z] = player.pos;
      // Which of the eight sides faces the camera: 0 is the front, counting to the player's left.
      const yawToCamera = Math.atan2(x - camera[0], z - camera[2]);
      const turns = Math.round((yawToCamera - player.yaw) / ((2 * Math.PI) / FRAME_COUNT));
      const frame = ((turns % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT;
      entry.body.material.map?.offset.set(frame / FRAME_COUNT, player.crouched ? 0 : 0.5);
      entry.body.position.set(x, y, z);
      entry.body.material.color.set(player.quad ? QUAD_COLOR : '#ffffff');

      const height = player.crouched ? PLAYER.crouchHeight : PLAYER.standHeight;
      entry.tag.position.set(x, y + height + NAME_GAP, z);
      entry.tag.visible = player.nameTag;

      entry.ghostIn -= dt;
      if (player.dashing && entry.ghostIn <= 0) {
        entry.ghostIn = GHOST_INTERVAL_S;
        this.leaveGhost(entry.body);
      }
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) this.remove(id, entry);
    }
  }

  private create(player: RenderPlayer): Entry {
    const atlas = pixelTexture(paintPlayerAtlas(player.color, player.accent));
    atlas.repeat.set(1 / FRAME_COUNT, 0.5);
    const body = new Sprite(new SpriteMaterial({ map: atlas, alphaTest: 0.5 }));
    body.center.set(0.5, 0);
    body.scale.set(SPRITE_WIDTH, PLAYER.standHeight, 1);

    const tagCanvas = paintNameTag(player.name, player.color);
    const tag = new Sprite(new SpriteMaterial({ map: pixelTexture(tagCanvas), alphaTest: 0.4 }));
    tag.center.set(0.5, 0);
    tag.scale.set((NAME_HEIGHT * tagCanvas.width) / tagCanvas.height, NAME_HEIGHT, 1);

    this.group.add(body, tag);
    return { name: player.name, color: player.color, accent: player.accent, body, tag, ghostIn: 0 };
  }

  /** A copy of the sprite as it looks right now, which stays in place and fades out. */
  private leaveGhost(body: Sprite): void {
    // The copy needs its own texture transform: the body keeps changing its frame.
    const map = body.material.map?.clone() ?? null;
    const sprite = new Sprite(
      new SpriteMaterial({ map, transparent: true, opacity: GHOST_OPACITY, depthWrite: false }),
    );
    sprite.center.copy(body.center);
    sprite.scale.copy(body.scale);
    sprite.position.copy(body.position);
    this.group.add(sprite);
    this.ghosts.push({ sprite, age: 0 });
  }

  private fadeGhosts(dt: number): void {
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const ghost = this.ghosts[i];
      if (!ghost) continue;
      ghost.age += dt;
      if (ghost.age < GHOST_LIFE_S) {
        ghost.sprite.material.opacity = GHOST_OPACITY * (1 - ghost.age / GHOST_LIFE_S);
        continue;
      }
      this.group.remove(ghost.sprite);
      // The cloned texture shares its image with the body; only the clone is released.
      ghost.sprite.material.map?.dispose();
      ghost.sprite.material.dispose();
      this.ghosts.splice(i, 1);
    }
  }

  private remove(id: string, entry: Entry): void {
    for (const sprite of [entry.body, entry.tag]) {
      this.group.remove(sprite);
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
    this.entries.delete(id);
  }
}
