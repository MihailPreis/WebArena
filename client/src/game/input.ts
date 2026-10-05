import type { InputCmd } from './sim/movement';

// Radians per mouse count at sensitivity 1.
const RADIANS_PER_COUNT = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

const GAME_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'KeyC',
  'Tab',
]);
// Digit1 picks the first weapon, and so on.
const WEAPON_KEY = /^Digit([1-9])$/;

/** Keyboard and mouse state, active only while the pointer is locked to `target`. */
export class Input {
  yaw = 0;
  pitch = 0;
  private readonly keys = new Set<string>();
  /** Index of the weapon the player asked for, with a digit key or by the caller. */
  weapon = 0;
  private firing = false;
  private wheel = 0;
  private suspended = false;

  constructor(
    private readonly target: HTMLElement,
    private readonly sensitivity: () => number,
    onLockChange: (locked: boolean) => void,
  ) {
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked) this.release();
      onLockChange(this.locked);
    });
    document.addEventListener('mousemove', (event) => {
      if (!this.locked) return;
      const scale = RADIANS_PER_COUNT * this.sensitivity();
      this.yaw -= event.movementX * scale;
      // Keep yaw within one turn; the server rejects values far outside it.
      if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI;
      else if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;
      this.pitch -= event.movementY * scale;
      this.pitch = Math.min(Math.max(this.pitch, -PITCH_LIMIT), PITCH_LIMIT);
    });
    window.addEventListener('keydown', (event) => {
      if (!this.locked || this.suspended) return;
      const digit = WEAPON_KEY.exec(event.code);
      if (digit) this.weapon = Number(digit[1]) - 1;
      if (!GAME_KEYS.has(event.code)) return;
      event.preventDefault();
      this.keys.add(event.code);
    });
    document.addEventListener('wheel', (event) => {
      if (this.locked && !this.suspended) this.wheel += Math.sign(event.deltaY);
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.release());
    document.addEventListener('mousedown', (event) => {
      if (this.locked && !this.suspended && event.button === 0) this.firing = true;
    });
    document.addEventListener('mouseup', (event) => {
      if (event.button === 0) this.firing = false;
    });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  lock(): void {
    // Rejects if the browser refuses (e.g. right after Esc); the player can click again.
    void Promise.resolve(this.target.requestPointerLock()).catch(() => undefined);
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** While the player is typing, e.g. in the chat, keys and clicks are not game input. */
  suspend(on: boolean): void {
    this.suspended = on;
    this.release();
  }

  /** Notches the mouse wheel has turned since the last call; positive is towards the player. */
  takeWheel(): number {
    const turned = this.wheel;
    this.wheel = 0;
    return turned;
  }

  private release(): void {
    this.keys.clear();
    this.firing = false;
  }

  command(): InputCmd {
    const axis = (positive: string, negative: string) =>
      Number(this.keys.has(positive)) - Number(this.keys.has(negative));
    return {
      forward: axis('KeyW', 'KeyS'),
      right: axis('KeyD', 'KeyA'),
      jump: this.keys.has('Space'),
      crouch: this.keys.has('KeyC'),
      dash: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      yaw: this.yaw,
      pitch: this.pitch,
      fire: this.firing,
      weapon: this.weapon,
    };
  }
}
