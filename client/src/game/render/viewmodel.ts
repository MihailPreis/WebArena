// The weapon in the player's hands: placeholder pixel art painted in code and
// animated by moving a small canvas over the 3D view.

const SIZE = 64;
const FLASH_S = 0.05;
const KICK_PX = 14;
const KICK_RECOVERY = 14;
const BOB_PX = 5;
const LOWERED_PX = 70;
// Tip of the barrel in the painted image, in canvas pixels.
const MUZZLE_X = 32;
const MUZZLE_Y = 12;

function paint(ctx: CanvasRenderingContext2D, flash: boolean): void {
  const rect = (x: number, y: number, w: number, h: number, style: string) => {
    ctx.fillStyle = style;
    ctx.fillRect(x, y, w, h);
  };
  ctx.clearRect(0, 0, SIZE, SIZE);

  if (flash) {
    rect(24, 2, 16, 16, '#ffb347');
    rect(20, 6, 24, 8, '#ffb347');
    rect(27, 5, 10, 10, '#fff6c8');
  }
  // Barrel, seen from behind and slightly above.
  rect(28, 14, 8, 22, '#5d6470');
  rect(30, 14, 4, 22, '#7d8592');
  rect(29, 12, 6, 3, '#2b2f36');
  // Body.
  rect(24, 34, 16, 18, '#474d57');
  rect(26, 36, 12, 4, '#6b7380');
  rect(30, 30, 4, 5, '#2b2f36');
  // Hands.
  rect(18, 46, 12, 18, '#c98f6b');
  rect(34, 50, 14, 14, '#c98f6b');
  rect(18, 46, 12, 3, '#a8734f');
  rect(34, 50, 14, 3, '#a8734f');
  rect(26, 52, 12, 12, '#33373f');
}

export interface Viewmodel {
  /** Starts the muzzle flash and the recoil kick. */
  fire(): void;
  /** `stride` grows with distance walked; it drives the bob. */
  update(dt: number, stride: number, lowered: boolean): void;
  /** Where the tip of the barrel is on screen right now, in CSS pixels. */
  muzzle(): { x: number; y: number };
}

export function createViewmodel(canvas: HTMLCanvasElement): Viewmodel {
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  paint(ctx, false);

  let flash = 0;
  let flashShown = false;
  let kick = 0;
  let lowered = 0;

  return {
    fire() {
      flash = FLASH_S;
      kick = KICK_PX;
    },
    muzzle() {
      // The rectangle includes the bob and kick offsets applied through `transform`.
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + (rect.width * MUZZLE_X) / SIZE,
        y: rect.top + (rect.height * MUZZLE_Y) / SIZE,
      };
    },
    update(dt, stride, isLowered) {
      flash = Math.max(flash - dt, 0);
      if (flash > 0 !== flashShown) {
        flashShown = flash > 0;
        paint(ctx, flashShown);
      }
      kick *= Math.exp(-KICK_RECOVERY * dt);
      lowered += ((isLowered ? 1 : 0) - lowered) * (1 - Math.exp(-12 * dt));

      const bobX = Math.sin(stride * 2.6) * BOB_PX;
      const bobY = Math.abs(Math.cos(stride * 2.6)) * BOB_PX;
      canvas.style.transform = `translate(${bobX.toFixed(1)}px, ${(bobY + kick + lowered * LOWERED_PX).toFixed(1)}px)`;
    },
  };
}
