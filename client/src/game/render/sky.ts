import {
  BackSide,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  SphereGeometry,
  SRGBColorSpace,
} from 'three';

const WIDTH = 1024;
const HEIGHT = 512;

/** A dusk sky dome that fades into `horizon`, which should match the fog colour. */
export function buildSky(horizon: string): Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');

  const gradient = ctx.createLinearGradient(0, 0, 0, HEIGHT / 2);
  gradient.addColorStop(0, '#05030c');
  gradient.addColorStop(0.7, '#2a1838');
  gradient.addColorStop(1, horizon);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT / 2);
  ctx.fillStyle = horizon;
  ctx.fillRect(0, HEIGHT / 2, WIDTH, HEIGHT / 2);

  // Fixed pattern, so the stars do not change between loads.
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 500; i++) {
    const brightness = 120 + Math.floor(random() * 135);
    ctx.fillStyle = `rgb(${brightness}, ${brightness}, ${Math.min(255, brightness + 30)})`;
    ctx.fillRect(Math.floor(random() * WIDTH), Math.floor(random() * HEIGHT * 0.42), 1, 1);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;

  const sky = new Mesh(
    new SphereGeometry(100, 24, 12),
    new MeshBasicMaterial({ map: texture, side: BackSide, fog: false, depthWrite: false }),
  );
  sky.renderOrder = -1;
  return sky;
}
