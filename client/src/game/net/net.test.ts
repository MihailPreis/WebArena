import arenaJson from '@shared/maps/arena.json';
import { describe, expect, it } from 'vitest';
import { TICK_DT } from '../sim/constants';
import { parseMap } from '../sim/map';
import { createPlayer, stepPlayer, type InputCmd, type PlayerState } from '../sim/movement';
import { RemoteInterpolator } from './interpolation';
import { Prediction } from './prediction';

const arena = parseMap(arenaJson);
const FRESH = { hp: 100, alive: true, ammo: 20, cooldown: 0, reload: 0 };
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
    fire: false,
    reload: false,
    ...overrides,
  };
}

describe('Prediction', () => {
  /** A server that simulates the same inputs, `lag` ticks behind the client. */
  function runWithLag(lag: number, ticks: number) {
    const prediction = new Prediction(arena, createPlayer(spawn), FRESH);
    let server: PlayerState = createPlayer(spawn);
    const inFlight: { seq: number; cmd: InputCmd }[] = [];
    let largestCorrection = 0;

    for (let tick = 0; tick < ticks; tick++) {
      const input = cmd({ forward: 1, right: tick % 90 < 45 ? 1 : -1, jump: tick % 50 === 10 });
      inFlight.push({ seq: prediction.step(input).seq, cmd: input });
      if (inFlight.length > lag) {
        const arrived = inFlight.shift();
        if (!arrived) continue;
        server = stepPlayer(server, arrived.cmd, arena, TICK_DT);
        const correction = prediction.reconcile(server, FRESH, arrived.seq);
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
    const prediction = new Prediction(arena, createPlayer(spawn), FRESH);
    let seq = 0;
    for (let i = 0; i < 30; i++) seq = prediction.step(cmd({ forward: 1 })).seq;

    // The server put the player somewhere else, e.g. after a respawn.
    const moved = stepPlayer(createPlayer({ position: [10, 0, 0], yaw: 0 }), cmd(), arena, TICK_DT);
    const correction = prediction.reconcile(moved, FRESH, seq);
    expect(prediction.current.pos).toEqual(moved.pos);
    expect(prediction.previous.pos).toEqual(moved.pos);
    expect(Math.hypot(...correction)).toBeGreaterThan(5);
  });

  it('replays only the inputs the server has not seen', () => {
    const prediction = new Prediction(arena, createPlayer(spawn), FRESH);
    const states: PlayerState[] = [];
    for (let i = 0; i < 20; i++) {
      prediction.step(cmd({ forward: 1 }));
      states.push(prediction.current);
    }
    const acked = states[9];
    if (!acked) throw new Error('missing state');
    prediction.reconcile(acked, FRESH, 9);
    expect(prediction.current.pos).toEqual(states[19]?.pos);
    expect(prediction.previous.pos).toEqual(states[18]?.pos);
  });
});

describe('Prediction of the weapon and of death', () => {
  it('predicts shots and ammunition', () => {
    const prediction = new Prediction(arena, createPlayer(spawn), FRESH);
    expect(prediction.step(cmd({ fire: true })).fired).toBe(true);
    expect(prediction.step(cmd({ fire: true })).fired).toBe(false);
    expect(prediction.weapon.ammo).toBe(19);
  });

  it('takes ammunition from the server and replays unacknowledged shots', () => {
    const prediction = new Prediction(arena, createPlayer(spawn), FRESH);
    const first = prediction.step(cmd({ fire: true })).seq;
    for (let i = 0; i < 8; i++) prediction.step(cmd());
    prediction.step(cmd({ fire: true }));
    expect(prediction.weapon.ammo).toBe(18);

    // The server has simulated only the first shot so far.
    const afterFirst = { ...FRESH, ammo: 19, cooldown: 8 };
    prediction.reconcile(prediction.current, afterFirst, first);
    expect(prediction.weapon.ammo).toBe(18);
  });

  it('does not move or shoot while dead', () => {
    const prediction = new Prediction(arena, createPlayer(spawn), FRESH);
    const { seq } = prediction.step(cmd({ forward: 1 }));
    prediction.reconcile(prediction.current, { ...FRESH, hp: 0, alive: false }, seq);
    const frozen = prediction.current;
    expect(prediction.step(cmd({ forward: 1, fire: true })).fired).toBe(false);
    expect(prediction.current).toBe(frozen);
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
