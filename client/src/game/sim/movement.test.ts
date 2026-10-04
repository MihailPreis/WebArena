import arenaJson from '@shared/maps/arena.json';
import { describe, expect, it } from 'vitest';
import { overlapsAny } from './collision';
import { MOVEMENT, PLAYER, TICK_DT } from './constants';
import { FixedStep } from './fixedStep';
import { parseMap, type Block, type GameMap, type Vec3 } from './map';
import { createPlayer, stepPlayer, type InputCmd, type PlayerState } from './movement';

const FLOOR: Block = { min: [-50, -1, -50], max: [50, 0, 50], material: 'floor' };

function makeMap(...blocks: Block[]): GameMap {
  return { name: 'test', killY: -20, blocks: [FLOOR, ...blocks], spawns: [] };
}

function spawnAt(position: Vec3, map: GameMap): PlayerState {
  // One idle tick settles the player on the ground.
  return stepPlayer(createPlayer({ position, yaw: 0 }), cmd(), map, TICK_DT);
}

function cmd(overrides: Partial<InputCmd> = {}): InputCmd {
  return {
    forward: 0,
    right: 0,
    jump: false,
    crouch: false,
    sprint: false,
    yaw: 0,
    pitch: 0,
    fire: false,
    reload: false,
    ...overrides,
  };
}

function run(state: PlayerState, map: GameMap, input: InputCmd, seconds: number): PlayerState {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) state = stepPlayer(state, input, map, TICK_DT);
  return state;
}

const speed = (state: PlayerState) => Math.hypot(state.vel[0], state.vel[2]);

describe('ground movement', () => {
  const map = makeMap();

  it('lands and stays on the floor', () => {
    const state = run(createPlayer({ position: [0, 3, 0], yaw: 0 }), map, cmd(), 2);
    expect(state.onGround).toBe(true);
    expect(state.pos[1]).toBeCloseTo(0, 6);
    expect(state.vel[1]).toBe(0);
  });

  it('accelerates to run speed and no further', () => {
    const state = run(spawnAt([0, 0, 0], map), map, cmd({ forward: 1 }), 2);
    expect(speed(state)).toBeCloseTo(MOVEMENT.runSpeed, 6);
    expect(state.pos[2]).toBeLessThan(-10);
    expect(state.pos[0]).toBeCloseTo(0, 6);
  });

  it('sprints faster in any direction', () => {
    const forward = run(spawnAt([0, 0, 0], map), map, cmd({ forward: 1, sprint: true }), 2);
    expect(speed(forward)).toBeCloseTo(MOVEMENT.sprintSpeed, 6);
    const sideways = run(spawnAt([0, 0, 0], map), map, cmd({ right: 1, sprint: true }), 2);
    expect(speed(sideways)).toBeCloseTo(MOVEMENT.sprintSpeed, 6);
  });

  it('does not move faster diagonally', () => {
    const state = run(spawnAt([0, 0, 0], map), map, cmd({ forward: 1, right: 1 }), 2);
    expect(speed(state)).toBeCloseTo(MOVEMENT.runSpeed, 6);
  });

  it('follows yaw', () => {
    const state = run(spawnAt([0, 0, 0], map), map, cmd({ forward: 1, yaw: Math.PI / 2 }), 1);
    expect(state.pos[0]).toBeLessThan(-3);
    expect(state.pos[2]).toBeCloseTo(0, 6);
  });

  it('stops by friction when input is released', () => {
    let state = run(spawnAt([0, 0, 0], map), map, cmd({ forward: 1 }), 1);
    state = run(state, map, cmd(), 1);
    expect(speed(state)).toBe(0);
  });
});

describe('jumping', () => {
  const map = makeMap();
  const apex = (MOVEMENT.jumpSpeed * MOVEMENT.jumpSpeed) / (2 * MOVEMENT.gravity);

  it('reaches the expected height', () => {
    let state = spawnAt([0, 0, 0], map);
    let highest = 0;
    for (let i = 0; i < 120; i++) {
      state = stepPlayer(state, cmd({ jump: true }), map, TICK_DT);
      highest = Math.max(highest, state.pos[1]);
    }
    expect(highest).toBeGreaterThan(apex - 0.1);
    expect(highest).toBeLessThanOrEqual(apex);
  });

  it('needs a fresh press for every jump', () => {
    let state = spawnAt([0, 0, 0], map);
    let jumps = 0;
    for (let i = 0; i < 300; i++) {
      const next = stepPlayer(state, cmd({ jump: true }), map, TICK_DT);
      if (state.onGround && !next.onGround) jumps++;
      state = next;
    }
    expect(jumps).toBe(1);
  });
});

describe('collisions', () => {
  it('is stopped by a wall and slides along it', () => {
    const map = makeMap({ min: [-50, 0, -6], max: [50, 4, -5], material: 'wall' });
    const state = run(spawnAt([0, 0, 0], map), map, cmd({ forward: 1, right: 1 }), 3);
    expect(state.pos[2]).toBeCloseTo(-5 + PLAYER.halfWidth, 4);
    expect(state.pos[0]).toBeGreaterThan(5);
    expect(state.vel[2]).toBe(0);
  });

  it('does not tunnel through a thin wall at high speed', () => {
    const map = makeMap({ min: [-50, 0, -5.05], max: [50, 4, -5], material: 'wall' });
    const start = spawnAt([0, 0, 0], map);
    const state = run({ ...start, vel: [0, 0, -200] }, map, cmd({ forward: 1 }), 1);
    expect(state.pos[2]).toBeGreaterThan(-5);
  });

  it('walks up a low step', () => {
    const map = makeMap({ min: [-5, 0, -10], max: [5, 0.3, -3], material: 'stone' });
    const state = run(spawnAt([0, 0, 0], map), map, cmd({ forward: 1 }), 1.5);
    expect(state.pos[1]).toBeCloseTo(0.3, 6);
    expect(state.pos[2]).toBeLessThan(-4);
    expect(state.onGround).toBe(true);
  });

  it('is blocked by a ledge higher than the step height', () => {
    const map = makeMap({ min: [-5, 0, -10], max: [5, 1, -3], material: 'crate' });
    const state = run(spawnAt([0, 0, 0], map), map, cmd({ forward: 1 }), 1.5);
    expect(state.pos[1]).toBeCloseTo(0, 6);
    expect(state.pos[2]).toBeCloseTo(-3 + PLAYER.halfWidth, 4);
  });

  it('jumps onto a one metre crate', () => {
    const map = makeMap({ min: [-5, 0, -10], max: [5, 1, -3], material: 'crate' });
    let state = run(spawnAt([0, 0, 0], map), map, cmd({ forward: 1 }), 0.3);
    state = stepPlayer(state, cmd({ forward: 1, jump: true }), map, TICK_DT);
    state = run(state, map, cmd({ forward: 1 }), 1.5);
    expect(state.pos[1]).toBeCloseTo(1, 6);
    expect(state.onGround).toBe(true);
  });

  it('stays grounded while walking down stairs', () => {
    const steps: Block[] = [0, 1, 2, 3].map((i) => ({
      min: [-2, 0, -4 - i],
      max: [2, 1 - i * 0.25, -3 - i],
      material: 'stone',
    }));
    const map = makeMap({ min: [-2, 0, -3], max: [2, 1, 3], material: 'stone' }, ...steps);
    let state = spawnAt([0, 1, 0], map);
    for (let i = 0; i < 90; i++) {
      state = stepPlayer(state, cmd({ forward: 1 }), map, TICK_DT);
      expect(state.onGround).toBe(true);
    }
    expect(state.pos[1]).toBeCloseTo(0, 6);
  });
});

describe('crouching', () => {
  // A slab with a 1.3 m gap under it: too low to walk under, high enough to crawl under.
  const map = makeMap({ min: [-5, 1.3, -8], max: [5, 2, -3], material: 'metal' });

  it('moves slower, even with sprint held', () => {
    const input = cmd({ forward: 1, crouch: true, sprint: true });
    const state = run(spawnAt([0, 0, 20], map), map, input, 2);
    expect(speed(state)).toBeCloseTo(MOVEMENT.crouchSpeed, 6);
  });

  it('cannot walk under a low opening while standing', () => {
    const state = run(spawnAt([0, 0, 0], map), map, cmd({ forward: 1 }), 2);
    expect(state.pos[2]).toBeCloseTo(-3 + PLAYER.halfWidth, 4);
  });

  it('crawls under it and cannot stand up until clear', () => {
    let state = run(spawnAt([0, 0, 0], map), map, cmd({ forward: 1, crouch: true }), 1.5);
    expect(state.pos[2]).toBeLessThan(-3.5);
    expect(state.pos[2]).toBeGreaterThan(-7.5);

    state = run(state, map, cmd(), 0.5);
    expect(state.crouched).toBe(true);

    state = run(state, map, cmd({ forward: 1 }), 3);
    expect(state.pos[2]).toBeLessThan(-8.5);
    expect(state.crouched).toBe(false);
  });
});

describe('fixed timestep', () => {
  function simulate(fps: number): PlayerState {
    const map = makeMap({ min: [-5, 0, -10], max: [5, 0.3, -3], material: 'stone' });
    const loop = new FixedStep(TICK_DT);
    let state = spawnAt([0, 0, 0], map);
    for (let frame = 0; frame < fps * 2; frame++) {
      const steps = loop.advance(1 / fps);
      for (let i = 0; i < steps; i++) {
        state = stepPlayer(state, cmd({ forward: 1, right: 0.5 }), map, TICK_DT);
      }
    }
    return state;
  }

  it('gives the same result at 60 and 144 frames per second', () => {
    const slow = simulate(60);
    const fast = simulate(144);
    // The two runs may differ by one tick that has not been simulated yet.
    const oneTick = MOVEMENT.sprintSpeed * TICK_DT + 1e-6;
    expect(Math.abs(slow.pos[0] - fast.pos[0])).toBeLessThanOrEqual(oneTick);
    expect(Math.abs(slow.pos[2] - fast.pos[2])).toBeLessThanOrEqual(oneTick);
    expect(fast.pos[1]).toBeCloseTo(slow.pos[1], 6);
  });

  it('caps the number of steps after a long stall', () => {
    const loop = new FixedStep(TICK_DT, 8);
    expect(loop.advance(5)).toBe(8);
    expect(loop.advance(0)).toBe(0);
  });
});

describe('arena map', () => {
  const arena = parseMap(arenaJson);

  it('has a spawn for every player of a full room', () => {
    expect(arena.spawns.length).toBeGreaterThanOrEqual(8);
  });

  it('has spawns that are clear of geometry and above ground', () => {
    const r = PLAYER.halfWidth;
    for (const spawn of arena.spawns) {
      const [x, y, z] = spawn.position;
      expect(
        overlapsAny(arena.blocks, [x - r, y, z - r], [x + r, y + PLAYER.standHeight, z + r]),
      ).toBe(false);
      const settled = run(createPlayer(spawn), arena, cmd({ yaw: spawn.yaw }), 0.5);
      expect(settled.onGround).toBe(true);
      expect(settled.pos[1]).toBeCloseTo(y, 6);
    }
  });

  it('rejects malformed data', () => {
    expect(() => parseMap({ name: 'x', killY: 0, blocks: [], spawns: [] })).toThrow();
    expect(() =>
      parseMap({
        name: 'x',
        killY: 0,
        blocks: [{ min: [0, 0, 0], max: [1, 0, 1], material: 'wall' }],
        spawns: [{ position: [0, 0, 0], yawDeg: 0 }],
      }),
    ).toThrow();
  });
});
