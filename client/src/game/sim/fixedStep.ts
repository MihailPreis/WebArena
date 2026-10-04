/** Converts variable frame times into a whole number of fixed simulation steps. */
export class FixedStep {
  private accumulator = 0;

  constructor(
    readonly dt: number,
    /** Upper bound on steps per frame, so a long stall does not snowball. */
    readonly maxSteps = 8,
  ) {}

  /** Adds elapsed frame time and returns how many steps to simulate now. */
  advance(frameDt: number): number {
    this.accumulator += frameDt;
    let steps = Math.floor(this.accumulator / this.dt + 1e-9);
    if (steps > this.maxSteps) {
      steps = this.maxSteps;
      this.accumulator = steps * this.dt;
    }
    this.accumulator = Math.max(this.accumulator - steps * this.dt, 0);
    return steps;
  }

  /** How far the current frame is between the last two steps, 0..1. */
  get alpha(): number {
    return this.accumulator / this.dt;
  }
}
