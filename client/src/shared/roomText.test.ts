import { describe, expect, it } from 'vitest';
import { isRoomFull } from './api';
import { describeSettings } from './roomText';

const settings = { mode: 'deathmatch', killLimit: 25, timeLimitMin: 10, maxPlayers: 8 };

describe('describeSettings', () => {
  it('summarises match settings', () => {
    expect(describeSettings(settings)).toBe('Deathmatch · до 25 убийств · 10 мин · до 8 игроков');
  });

  it('falls back to the raw id for an unknown mode', () => {
    expect(describeSettings({ ...settings, mode: 'ctf' })).toContain('ctf');
  });
});

describe('isRoomFull', () => {
  const room = { code: 'AB12', hostId: 'h', players: 7, settings };

  it('is full only at the player limit', () => {
    expect(isRoomFull(room)).toBe(false);
    expect(isRoomFull({ ...room, players: 8 })).toBe(true);
  });
});
