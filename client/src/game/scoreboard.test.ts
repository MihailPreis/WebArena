import { describe, expect, it } from 'vitest';
import type { ScoreRow } from './net/protocol';
import { formatClock, killDeathRatio, resultTitle } from './scoreboard';

function row(name: string, kills: number, deaths: number): ScoreRow {
  return { id: name, name, color: '#ffffff', kills, deaths, ping: 20, online: true };
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
