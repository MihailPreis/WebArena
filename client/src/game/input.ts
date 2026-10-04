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

/** Keyboard and mouse state, active only while the pointer is locked to `target`. */
export class Input {
  yaw = 0;
  pitch = 0;
  private readonly keys = new Set<string>();

  constructor(
    private readonly target: HTMLElement,
    private readonly sensitivity: () => number,
    onLockChange: (locked: boolean) => void,
  ) {
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked) this.keys.clear();
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
      if (!this.locked || !GAME_KEYS.has(event.code)) return;
      event.preventDefault();
      this.keys.add(event.code);
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  lock(): void {
    // Rejects if the browser refuses (e.g. right after Esc); the player can click again.
    void Promise.resolve(this.target.requestPointerLock()).catch(() => undefined);
  }

  command(): InputCmd {
    const axis = (positive: string, negative: string) =>
      Number(this.keys.has(positive)) - Number(this.keys.has(negative));
    return {
      forward: axis('KeyW', 'KeyS'),
      right: axis('KeyD', 'KeyA'),
      jump: this.keys.has('Space'),
      crouch: this.keys.has('KeyC'),
      sprint: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }
}
