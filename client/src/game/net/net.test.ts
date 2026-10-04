import arenaJson from '@shared/maps/arena.json';
import { describe, expect, it } from 'vitest';
import { TICK_DT } from '../sim/constants';
import { parseMap } from '../sim/map';
import { createPlayer, stepPlayer, type InputCmd, type PlayerState } from '../sim/movement';
import { RemoteInterpolator } from './interpolation';
import { Prediction } from './prediction';

const arena = parseMap(arenaJson);
const spawn = { position: [0, 0, 16] as [number, number, number], yaw: 0 };

function cmd(overrides: Partial<InputCmd> = {}): InputCmd {
  return {
    forward: 0,
    right: 0,
    jump: false,
    crouch: false,
    sprint: false,
    yaw: 0,
    pitch: 0,
    ...overrides,
  };
}

describe('Prediction', () => {
  /** A server that simulates the same inputs, `lag` ticks behind the client. */
  function runWithLag(lag: number, ticks: number) {
    const prediction = new Prediction(arena, createPlayer(spawn));
    let server: PlayerState = createPlayer(spawn);
    const inFlight: { seq: number; cmd: InputCmd }[] = [];
    let largestCorrection = 0;

    for (let tick = 0; tick < ticks; tick++) {
      const input = cmd({ forward: 1, right: tick % 90 < 45 ? 1 : -1, jump: tick % 50 === 10 });
      inFlight.push({ seq: prediction.step(input), cmd: input });
      if (inFlight.length > lag) {
        const arrived = inFlight.shift();
        if (!arrived) continue;
        server = stepPlayer(server, arrived.cmd, arena, TICK_DT);
        const correction = prediction.reconcile(server, arrived.seq);
        largestCorrection = Math.max(largestCorrection, Math.hypot(...correction));
      }
    }
    return { prediction, server, largestCorrection };
  }

  it('needs no correction when the server agrees', () => {
    const { largestCorrection } = runWithLag(6, 300);
    expect(largestCorrection).toBeLessThan(1e-9);
  });

  it('stays ahead of the server by the unacknowledged inputs', () => {
    const { prediction, server } = runWithLag(6, 300);
    expect(prediction.current.pos).not.toEqual(server.pos);
    expect(Math.hypot(prediction.current.pos[0] - server.pos[0])).toBeLessThan(1.5);
  });

  it('adopts the server state when the server disagrees', () => {
    const prediction = new Prediction(arena, createPlayer(spawn));
    let seq = 0;
    for (let i = 0; i < 30; i++) seq = prediction.step(cmd({ forward: 1 }));

    // The server put the player somewhere else, e.g. after a respawn.
    const moved = stepPlayer(createPlayer({ position: [10, 0, 0], yaw: 0 }), cmd(), arena, TICK_DT);
    const correction = prediction.reconcile(moved, seq);
    expect(prediction.current.pos).toEqual(moved.pos);
    expect(prediction.previous.pos).toEqual(moved.pos);
    expect(Math.hypot(...correction)).toBeGreaterThan(5);
  });

  it('replays only the inputs the server has not seen', () => {
    const prediction = new Prediction(arena, createPlayer(spawn));
    const states: PlayerState[] = [];
    for (let i = 0; i < 20; i++) {
      prediction.step(cmd({ forward: 1 }));
      states.push(prediction.current);
    }
    const acked = states[9];
    if (!acked) throw new Error('missing state');
    prediction.reconcile(acked, 9);
    expect(prediction.current.pos).toEqual(states[19]?.pos);
    expect(prediction.previous.pos).toEqual(states[18]?.pos);
  });
});

describe('RemoteInterpolator', () => {
  const at = (x: number, yaw = 0) => [
    { id: 'p', pos: [x, 0, 0] as [number, number, number], yaw, crouched: false },
  ];

  it('renders players in the past, between two snapshots', () => {
    const interpolator = new RemoteInterpolator(0.1);
    interpolator.push(1.0, 11.0, at(0));
    interpolator.push(1.1, 11.1, at(1));
    interpolator.push(1.2, 11.2, at(2));
    // Local 11.25 is server 1.25; minus the 0.1 s delay is 1.15.
    const [player] = interpolator.sample(11.25);
    expect(player?.pos[0]).toBeCloseTo(1.5, 6);
  });

  it('holds the last position instead of extrapolating', () => {
    const interpolator = new RemoteInterpolator(0.1);
    interpolator.push(1.0, 11.0, at(0));
    interpolator.push(1.1, 11.1, at(1));
    expect(interpolator.sample(15)[0]?.pos[0]).toBe(1);
  });

  it('turns the short way around', () => {
    const interpolator = new RemoteInterpolator(0);
    interpolator.push(1.0, 1.0, at(0, 3.1));
    interpolator.push(1.1, 1.1, at(0, -3.1));
    const yaw = interpolator.sample(1.05)[0]?.yaw ?? 0;
    expect(Math.abs(yaw)).toBeGreaterThan(3.1);
  });

  it('snaps on a respawn instead of sliding across the map', () => {
    const interpolator = new RemoteInterpolator(0);
    interpolator.push(1.0, 1.0, at(0));
    interpolator.push(1.1, 1.1, at(30));
    expect(interpolator.sample(1.05)[0]?.pos[0]).toBe(30);
  });

  it('forgets players that left', () => {
    const interpolator = new RemoteInterpolator(0);
    interpolator.push(1.0, 1.0, at(0));
    interpolator.push(1.1, 1.1, []);
    expect(interpolator.sample(1.1)).toEqual([]);
  });
});
