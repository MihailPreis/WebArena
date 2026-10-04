import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import arenaJson from '@shared/maps/arena.json';
import { describe, expect, it } from 'vitest';
import { TICK_DT } from './constants';
import { parseMap, type Vec3 } from './map';
import { createPlayer, stepPlayer } from './movement';

// The same file is replayed by the server (server/tests/test_movement_vectors.py):
// both implementations of the movement code must produce these results.
const VECTORS_PATH = resolve(import.meta.dirname, '../../../../shared/movement_vectors.json');
const TOLERANCE = 1e-9;

interface Segment {
  ticks: number;
  cmd: {
    forward: number;
    right: number;
    jump: boolean;
    crouch: boolean;
    sprint: boolean;
    yawDeg: number;
    pitch: number;
  };
}

interface Expected {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  crouched: boolean;
}

interface Case {
  name: string;
  start: { pos: Vec3; yawDeg: number };
  segments: Segment[];
  expect?: Expected[];
}

interface Vectors {
  cases: Case[];
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf-8')) as Vectors;
const arena = parseMap(arenaJson);

function simulate(testCase: Case): Expected[] {
  let state = createPlayer({ position: testCase.start.pos, yaw: radians(testCase.start.yawDeg) });
  return testCase.segments.map(({ ticks, cmd }) => {
    const input = { ...cmd, yaw: radians(cmd.yawDeg) };
    for (let i = 0; i < ticks; i++) state = stepPlayer(state, input, arena, TICK_DT);
    return { pos: state.pos, vel: state.vel, onGround: state.onGround, crouched: state.crouched };
  });
}

if (process.env.UPDATE_VECTORS) {
  for (const testCase of vectors.cases) testCase.expect = simulate(testCase);
  writeFileSync(VECTORS_PATH, JSON.stringify(vectors, null, 1) + '\n');
}

describe('movement vectors', () => {
  it.each(vectors.cases)('$name', (testCase) => {
    const actual = simulate(testCase);
    const expected = testCase.expect ?? [];
    expect(expected).toHaveLength(actual.length);
    actual.forEach((state, i) => {
      const want = expected[i];
      if (!want) throw new Error(`segment ${i} has no expectation`);
      expect(state.onGround, `segment ${i} onGround`).toBe(want.onGround);
      expect(state.crouched, `segment ${i} crouched`).toBe(want.crouched);
      for (const axis of [0, 1, 2] as const) {
        expect(Math.abs(state.pos[axis] - want.pos[axis])).toBeLessThanOrEqual(TOLERANCE);
        expect(Math.abs(state.vel[axis] - want.vel[axis])).toBeLessThanOrEqual(TOLERANCE);
      }
    });
  });
});
