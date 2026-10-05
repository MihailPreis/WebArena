import { describe, expect, it } from 'vitest';
import type { RoomStateMsg, ScoreRow, Team } from './net/protocol';
import {
  formatClock,
  killDeathRatio,
  outcomeFor,
  resultTitle,
  teamScoreLine,
  winningTeam,
} from './scoreboard';

function row(name: string, kills: number, deaths: number): ScoreRow {
  return { id: name, name, color: '#ffffff', team: null, kills, deaths, ping: 20, online: true };
}

describe('killDeathRatio', () => {
  it('divides kills by deaths', () => {
    expect(killDeathRatio(10, 4)).toBe('2.50');
  });

  it('treats no deaths as one', () => {
    expect(killDeathRatio(7, 0)).toBe('7.00');
    expect(killDeathRatio(0, 0)).toBe('0.00');
  });
});

describe('formatClock', () => {
  it('shows minutes and seconds', () => {
    expect(formatClock(600)).toBe('10:00');
    expect(formatClock(59.2)).toBe('1:00');
    expect(formatClock(9)).toBe('0:09');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('resultTitle', () => {
  it('names the first player as the winner', () => {
    expect(resultTitle([row('Alice', 25, 3), row('Bob', 10, 8)]).winner?.name).toBe('Alice');
  });

  it('calls a draw when the top two are level', () => {
    expect(resultTitle([row('Alice', 5, 5), row('Bob', 5, 5)]).winner).toBeNull();
    expect(resultTitle([]).winner).toBeNull();
  });

  it('breaks a tie on kills by deaths', () => {
    expect(resultTitle([row('Alice', 5, 2), row('Bob', 5, 5)]).winner?.name).toBe('Alice');
  });
});

describe('team scores', () => {
  it('names the team with more kills', () => {
    expect(winningTeam({ blue: 12, red: 9 })).toBe('blue');
    expect(winningTeam({ blue: 3, red: 9 })).toBe('red');
  });

  it('has no winner when level', () => {
    expect(winningTeam({ blue: 4, red: 4 })).toBeNull();
  });

  it('formats the score line', () => {
    expect(teamScoreLine({ blue: 12, red: 9 })).toBe('Синие 12 : 9 Красные');
  });
});

function results(players: ScoreRow[], teams: Record<Team, number> | null): RoomStateMsg {
  return {
    t: 'room',
    state: 'results',
    timeLeft: 10,
    hostId: 'Alice',
    teams,
    settings: { mode: 'deathmatch', map: 'gate', killLimit: 25, timeLimitMin: 10, maxPlayers: 8 },
    players,
  };
}

describe('outcomeFor', () => {
  it('tells the winner of a free-for-all from the rest', () => {
    const state = results([row('Alice', 25, 3), row('Bob', 10, 8)], null);
    expect(outcomeFor(state, 'Alice')).toBe('win');
    expect(outcomeFor(state, 'Bob')).toBe('loss');
  });

  it('is a draw when the top two are level', () => {
    const state = results([row('Alice', 5, 5), row('Bob', 5, 5)], null);
    expect(outcomeFor(state, 'Alice')).toBe('draw');
  });

  it('follows the team in a team mode', () => {
    const players = [
      { ...row('Alice', 2, 9), team: 'blue' as const },
      { ...row('Bob', 9, 2), team: 'red' as const },
    ];
    expect(outcomeFor(results(players, { blue: 12, red: 9 }), 'Alice')).toBe('win');
    expect(outcomeFor(results(players, { blue: 12, red: 9 }), 'Bob')).toBe('loss');
    expect(outcomeFor(results(players, { blue: 4, red: 4 }), 'Bob')).toBe('draw');
  });
});
