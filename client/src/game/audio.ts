import type { Vec3 } from './sim/map';

/**
 * Sound effects synthesised with Web Audio; there are no audio files.
 * Sounds given a position are placed in the world relative to the listener.
 */
export class GameAudio {
  private context: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private volume = 0.5;

  /** Overall loudness, 0 to 1. */
  setVolume(volume: number): void {
    this.volume = volume;
    if (this.master) this.master.gain.value = volume;
  }

  /** Browsers only allow sound after a user gesture; call this from a click. */
  resume(): void {
    if (!this.context) {
      const context = new AudioContext();
      this.context = context;
      this.master = context.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(context.destination);

      const length = context.sampleRate / 2;
      this.noise = context.createBuffer(1, length, context.sampleRate);
      const samples = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) samples[i] = Math.random() * 2 - 1;
    }
    void this.context.resume();
  }

  setListener(position: Vec3, yaw: number): void {
    const listener = this.context?.listener;
    if (!listener) return;
    const forward = [-Math.sin(yaw), 0, -Math.cos(yaw)] as const;
    if (listener.positionX) {
      listener.positionX.value = position[0];
      listener.positionY.value = position[1];
      listener.positionZ.value = position[2];
      listener.forwardX.value = forward[0];
      listener.forwardY.value = forward[1];
      listener.forwardZ.value = forward[2];
      listener.upY.value = 1;
    } else {
      // Older Safari and Firefox.
      listener.setPosition(...position);
      listener.setOrientation(forward[0], forward[1], forward[2], 0, 1, 0);
    }
  }

  /** A shot from the weapon with the given index; for the rocket launcher, the launch. */
  shot(at: Vec3 | null, weapon = 0): void {
    const near = at === null;
    switch (weapon) {
      case 1:
        this.burst(at, { volume: near ? 0.9 : 1.2, duration: 0.3, filter: 1100 });
        this.tone(at, { from: 130, to: 40, duration: 0.22, volume: 0.7, type: 'square' });
        break;
      case 2:
        this.burst(at, { volume: near ? 0.6 : 0.9, duration: 0.4, filter: 700 });
        this.tone(at, { from: 90, to: 240, duration: 0.3, volume: 0.35, type: 'sawtooth' });
        break;
      case 3:
        this.tone(at, { from: 2200, to: 180, duration: 0.4, volume: 0.5, type: 'sawtooth' });
        this.burst(at, { volume: near ? 0.5 : 0.8, duration: 0.2, filter: 4000 });
        break;
      default:
        this.burst(at, { volume: near ? 0.45 : 0.75, duration: 0.12, filter: 1800 });
        this.tone(at, { from: 180, to: 50, duration: 0.1, volume: 0.45, type: 'square' });
    }
  }

  explosion(at: Vec3): void {
    this.burst(at, { volume: 1.6, duration: 0.7, filter: 450 });
    this.tone(at, { from: 90, to: 28, duration: 0.55, volume: 0.9, type: 'sine' });
  }

  /** Somebody took an item; `kind` is `weapon`, `ammo`, `health`, `armor` or `quad`. */
  pickup(at: Vec3 | null, kind: string): void {
    const volume = at ? 0.5 : 0.3;
    if (kind === 'quad') {
      this.tone(at, { from: 220, to: 880, duration: 0.5, volume: volume * 1.4, type: 'sawtooth' });
    } else if (kind === 'health') {
      this.tone(at, { from: 520, to: 780, duration: 0.16, volume, type: 'sine' });
    } else if (kind === 'armor') {
      this.tone(at, { from: 300, to: 420, duration: 0.18, volume, type: 'triangle' });
    } else {
      this.burst(at, { volume: volume * 0.8, duration: 0.05, filter: 3000 });
      this.tone(at, { from: 700, to: 500, duration: 0.06, volume: volume * 0.7, type: 'square' });
    }
  }

  /** The player's own shot landed. */
  hitConfirm(strong: boolean): void {
    this.tone(null, {
      from: strong ? 1500 : 1100,
      to: strong ? 1500 : 1100,
      duration: 0.06,
      volume: 0.35,
      type: 'square',
    });
  }

  /** The player took damage. */
  hurt(): void {
    this.tone(null, { from: 220, to: 90, duration: 0.18, volume: 0.6, type: 'sawtooth' });
  }

  death(at: Vec3 | null): void {
    this.tone(at, { from: 400, to: 60, duration: 0.6, volume: 0.6, type: 'sawtooth' });
  }

  step(at: Vec3 | null): void {
    this.burst(at, { volume: at ? 0.5 : 0.18, duration: 0.07, filter: 500 });
  }

  /** A rush of air: a dash or a slide. */
  dash(at: Vec3 | null): void {
    this.burst(at, { volume: at ? 0.7 : 0.35, duration: 0.22, filter: 900 });
    this.tone(at, { from: 140, to: 320, duration: 0.14, volume: 0.12, type: 'sine' });
  }

  /** The weapon in hand has changed. */
  weaponSwitch(): void {
    this.burst(null, { volume: 0.2, duration: 0.05, filter: 2500 });
  }

  private output(at: Vec3 | null): AudioNode | null {
    if (!this.context || !this.master) return null;
    if (!at) return this.master;
    const panner = new PannerNode(this.context, {
      panningModel: 'equalpower',
      distanceModel: 'inverse',
      refDistance: 3,
      maxDistance: 80,
      rolloffFactor: 1.2,
      positionX: at[0],
      positionY: at[1],
      positionZ: at[2],
    });
    panner.connect(this.master);
    return panner;
  }

  private burst(
    at: Vec3 | null,
    options: { volume: number; duration: number; filter: number },
  ): void {
    const output = this.output(at);
    if (!this.context || !this.noise || !output) return;
    const now = this.context.currentTime;
    const source = new AudioBufferSourceNode(this.context, { buffer: this.noise });
    const filter = new BiquadFilterNode(this.context, {
      type: 'lowpass',
      frequency: options.filter,
    });
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(options.volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + options.duration);
    source.connect(filter).connect(gain).connect(output);
    source.start(now, Math.random() * 0.3, options.duration);
  }

  private tone(
    at: Vec3 | null,
    options: { from: number; to: number; duration: number; volume: number; type: OscillatorType },
  ): void {
    const output = this.output(at);
    if (!this.context || !output) return;
    const now = this.context.currentTime;
    const oscillator = new OscillatorNode(this.context, { type: options.type });
    oscillator.frequency.setValueAtTime(options.from, now);
    oscillator.frequency.exponentialRampToValueAtTime(options.to, now + options.duration);
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(options.volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + options.duration);
    oscillator.connect(gain).connect(output);
    oscillator.start(now);
    oscillator.stop(now + options.duration);
  }
}
