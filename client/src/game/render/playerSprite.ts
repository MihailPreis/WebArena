// Placeholder player art, painted in code: a blocky figure seen from eight sides,
// standing and crouching. Replace this module to change how players look.

export const FRAME_COUNT = 8;
const CELL_WIDTH = 16;
const CELL_HEIGHT = 32;

function shade(hex: string, factor: number): string {
  const channel = (offset: number) =>
    Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(offset, offset + 2), 16) * factor)));
  return `rgb(${channel(1)}, ${channel(3)}, ${channel(5)})`;
}

function drawFigure(
  ctx: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  frame: number,
  crouched: boolean,
  color: string,
): void {
  const rect = (x: number, y: number, w: number, h: number, style: string) => {
    ctx.fillStyle = style;
    ctx.fillRect(originX + Math.round(x), originY + y, w, h);
  };

  // Frame 0 faces the viewer; each next frame turns the figure by 45 degrees.
  const angle = (frame * Math.PI) / 4;
  const side = -Math.sin(angle); // Where the figure's front points on screen: -1 left, 1 right.
  const toward = Math.cos(angle); // 1 facing the viewer, -1 facing away.

  const headTop = crouched ? 13 : 1;
  const torsoTop = headTop + 6;
  const torsoHeight = crouched ? 7 : 10;
  const legsTop = torsoTop + torsoHeight;
  const centre = CELL_WIDTH / 2;
  const torsoWidth = 6 + Math.round(2 * Math.abs(toward));
  const torsoLeft = centre - torsoWidth / 2;

  rect(centre - 3, legsTop, 2, 30 - legsTop, '#33333d');
  rect(centre + 1, legsTop, 2, 30 - legsTop, '#33333d');
  rect(centre - 3, 30, 3, 2, '#15151a');
  rect(centre + 1, 30, 3, 2, '#15151a');

  rect(torsoLeft, torsoTop, torsoWidth, torsoHeight, color);
  rect(torsoLeft, torsoTop + torsoHeight - 2, torsoWidth, 2, shade(color, 0.7));
  if (Math.abs(side) > 0.9) {
    rect(centre - 1, torsoTop + 1, 2, torsoHeight - 3, shade(color, 0.6));
  } else {
    rect(torsoLeft - 2, torsoTop, 2, torsoHeight - 2, shade(color, 0.6));
    rect(torsoLeft + torsoWidth, torsoTop, 2, torsoHeight - 2, shade(color, 0.6));
  }
  if (toward < -0.3) rect(centre - 2, torsoTop + 1, 4, 5, shade(color, 0.45));

  rect(centre - 3, headTop, 6, 6, shade(color, 0.85));
  if (toward > -0.3) {
    const visorWidth = toward > 0.5 ? 4 : 2;
    rect(centre + side * 2.5 - visorWidth / 2, headTop + 2, visorWidth, 2, '#7fe9ff');
  }

  if (toward > 0.5) rect(centre - 1, torsoTop + 3, 2, 4, '#9aa0a8');
  else if (toward > -0.8) rect(side > 0 ? centre + 1 : centre - 7, torsoTop + 3, 6, 2, '#9aa0a8');
}

/** Paints all frames for one player colour: a row of standing frames above a row of crouching ones. */
export function paintPlayerAtlas(color: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_WIDTH * FRAME_COUNT;
  canvas.height = CELL_HEIGHT * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    drawFigure(ctx, frame * CELL_WIDTH, 0, frame, false, color);
    drawFigure(ctx, frame * CELL_WIDTH, CELL_HEIGHT, frame, true, color);
  }
  return canvas;
}

/** Paints a name tag and returns it with its width-to-height ratio. */
export function paintNameTag(name: string, color: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  const font = 'bold 16px ui-monospace, Menlo, Consolas, monospace';
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(name).width) + 6;
  canvas.height = 22;
  // Resizing a canvas resets its state.
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000';
  ctx.strokeText(name, 3, 11);
  ctx.fillStyle = color;
  ctx.fillText(name, 3, 11);
  return canvas;
}
