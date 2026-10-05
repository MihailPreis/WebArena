// The weapon in the player's hands: placeholder pixel art painted in code and
// animated by moving a small canvas over the 3D view.

const SIZE = 64;
const FLASH_S = 0.05;
const KICK_PX = 14;
const KICK_RECOVERY = 14;
const BOB_PX = 5;
const LOWERED_PX = 70;
// Centre line of the barrel in the painted image, in canvas pixels.
const MUZZLE_X = 32;

interface Look {
  barrel: string;
  shine: string;
  body: string;
  flash: string;
  /** Width of the barrel and the row its tip is on, in canvas pixels. */
  width: number;
  top: number;
}

// One per weapon, in the order of `weapons` in shared/constants.json.
const LOOKS: Look[] = [
  { barrel: '#5d6470', shine: '#7d8592', body: '#474d57', flash: '#ffb347', width: 8, top: 14 },
  { barrel: '#6b5a48', shine: '#8a765f', body: '#4f4033', flash: '#ffb347', width: 12, top: 18 },
  { barrel: '#4f5d47', shine: '#6c7d62', body: '#3b4735', flash: '#ff7a2e', width: 18, top: 16 },
  { barrel: '#2f3950', shine: '#48dbfb', body: '#27304a', flash: '#48dbfb', width: 6, top: 8 },
];

function paint(ctx: CanvasRenderingContext2D, look: Look, flash: boolean): void {
  const rect = (x: number, y: number, w: number, h: number, style: string) => {
    ctx.fillStyle = style;
    ctx.fillRect(x, y, w, h);
  };
  ctx.clearRect(0, 0, SIZE, SIZE);
  const { width, top } = look;
  const left = MUZZLE_X - width / 2;

  if (flash) {
    rect(24, top - 12, 16, 16, look.flash);
    rect(20, top - 8, 24, 8, look.flash);
    rect(27, top - 9, 10, 10, '#fff6c8');
  }
  // Barrel, seen from behind and slightly above.
  rect(left, top, width, 36 - top, look.barrel);
  rect(MUZZLE_X - width / 4, top, width / 2, 36 - top, look.shine);
  rect(left + 1, top - 2, width - 2, 3, '#2b2f36');
  // Body.
  rect(24, 34, 16, 18, look.body);
  rect(26, 36, 12, 4, look.shine);
  rect(30, 30, 4, 5, '#2b2f36');
  // Hands.
  rect(18, 46, 12, 18, '#c98f6b');
  rect(34, 50, 14, 14, '#c98f6b');
  rect(18, 46, 12, 3, '#a8734f');
  rect(34, 50, 14, 3, '#a8734f');
  rect(26, 52, 12, 12, '#33373f');
}

export interface Viewmodel {
  /** Shows the weapon with the given index; a change dips the hands out of view. */
  setWeapon(index: number): void;
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

  let weapon = 0;
  let look = LOOKS[0] as Look;
  let flash = 0;
  let flashShown = false;
  let kick = 0;
  let lowered = 0;
  paint(ctx, look, false);

  return {
    setWeapon(index) {
      if (index === weapon) return;
      weapon = index;
      look = LOOKS[index] ?? look;
      flash = 0;
      flashShown = false;
      paint(ctx, look, false);
      lowered = 1;
    },
    fire() {
      flash = FLASH_S;
      kick = KICK_PX;
    },
    muzzle() {
      // The rectangle includes the bob and kick offsets applied through `transform`.
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + (rect.width * MUZZLE_X) / SIZE,
        y: rect.top + (rect.height * (look.top - 2)) / SIZE,
      };
    },
    update(dt, stride, isLowered) {
      flash = Math.max(flash - dt, 0);
      if (flash > 0 !== flashShown) {
        flashShown = flash > 0;
        paint(ctx, look, flashShown);
      }
      kick *= Math.exp(-KICK_RECOVERY * dt);
      lowered += ((isLowered ? 1 : 0) - lowered) * (1 - Math.exp(-12 * dt));

      const bobX = Math.sin(stride * 2.6) * BOB_PX;
      const bobY = Math.abs(Math.cos(stride * 2.6)) * BOB_PX;
      canvas.style.transform = `translate(${bobX.toFixed(1)}px, ${(bobY + kick + lowered * LOWERED_PX).toFixed(1)}px)`;
    },
  };
}
