import { CanvasTexture, Group, NearestFilter, Sprite, SpriteMaterial, SRGBColorSpace } from 'three';
import { PLAYER } from '../sim/constants';
import type { Vec3 } from '../sim/map';
import { FRAME_COUNT, paintNameTag, paintPlayerAtlas } from './playerSprite';

const SPRITE_WIDTH = 0.9;
const NAME_HEIGHT = 0.36;
const NAME_GAP = 0.15;

export interface RenderPlayer {
  id: string;
  name: string;
  color: string;
  /** Feet position. */
  pos: Vec3;
  yaw: number;
  crouched: boolean;
}

interface Entry {
  name: string;
  color: string;
  body: Sprite;
  tag: Sprite;
}

function pixelTexture(canvas: HTMLCanvasElement): CanvasTexture {
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

  update(players: readonly RenderPlayer[], camera: Vec3): void {
    const seen = new Set<string>();
    for (const player of players) {
      seen.add(player.id);
      let entry = this.entries.get(player.id);
      if (entry && (entry.name !== player.name || entry.color !== player.color)) {
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

      const height = player.crouched ? PLAYER.crouchHeight : PLAYER.standHeight;
      entry.tag.position.set(x, y + height + NAME_GAP, z);
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) this.remove(id, entry);
    }
  }

  private create(player: RenderPlayer): Entry {
    const atlas = pixelTexture(paintPlayerAtlas(player.color));
    atlas.repeat.set(1 / FRAME_COUNT, 0.5);
    const body = new Sprite(new SpriteMaterial({ map: atlas, alphaTest: 0.5 }));
    body.center.set(0.5, 0);
    body.scale.set(SPRITE_WIDTH, PLAYER.standHeight, 1);

    const tagCanvas = paintNameTag(player.name, player.color);
    const tag = new Sprite(new SpriteMaterial({ map: pixelTexture(tagCanvas), alphaTest: 0.4 }));
    tag.center.set(0.5, 0);
    tag.scale.set((NAME_HEIGHT * tagCanvas.width) / tagCanvas.height, NAME_HEIGHT, 1);

    this.group.add(body, tag);
    return { name: player.name, color: player.color, body, tag };
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
