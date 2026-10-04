import { BoxGeometry, BufferAttribute, Group, Mesh, MeshBasicMaterial } from 'three';
import type { Block, GameMap } from '../sim/map';
import { createMaterialLooks } from './textures';

// Fixed brightness per box face (+x, -x, +y, -y, +z, -z) instead of real lighting.
const FACE_SHADE = [0.8, 0.8, 1, 0.5, 0.62, 0.62];

function blockGeometry(block: Block, tile: number): BoxGeometry {
  const sx = block.max[0] - block.min[0];
  const sy = block.max[1] - block.min[1];
  const sz = block.max[2] - block.min[2];
  const geometry = new BoxGeometry(sx, sy, sz);

  // Scale UVs by face size so the texture keeps its world scale on any block.
  const faceSize = [
    [sz, sy],
    [sz, sy],
    [sx, sz],
    [sx, sz],
    [sx, sy],
    [sx, sy],
  ] as const;
  const uv = geometry.getAttribute('uv');
  const colors = new Float32Array(uv.count * 3);
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4);
    const [u, v] = faceSize[face] ?? [1, 1];
    uv.setXY(i, (uv.getX(i) * u) / tile, (uv.getY(i) * v) / tile);
    colors.fill(FACE_SHADE[face] ?? 1, i * 3, i * 3 + 3);
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

export function buildWorld(map: GameMap): Group {
  const looks = createMaterialLooks();
  const materials = new Map<string, MeshBasicMaterial>();
  const group = new Group();

  for (const block of map.blocks) {
    const look = looks(block.material);
    let material = materials.get(block.material);
    if (!material) {
      material = new MeshBasicMaterial({ map: look.texture, vertexColors: true });
      materials.set(block.material, material);
    }
    const mesh = new Mesh(blockGeometry(block, look.tile), material);
    mesh.position.set(
      (block.min[0] + block.max[0]) / 2,
      (block.min[1] + block.max[1]) / 2,
      (block.min[2] + block.max[2]) / 2,
    );
    group.add(mesh);
  }
  return group;
}
