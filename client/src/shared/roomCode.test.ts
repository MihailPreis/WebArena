import { describe, expect, it } from 'vitest';
import { isRoomCode, roomCodeFromPath } from './roomCode';

describe('isRoomCode', () => {
  it('accepts four uppercase letters or digits', () => {
    expect(isRoomCode('AB12')).toBe(true);
    expect(isRoomCode('0000')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const value of ['ab12', 'ABC', 'ABCDE', 'AB-1', '']) {
      expect(isRoomCode(value)).toBe(false);
    }
  });
});

describe('roomCodeFromPath', () => {
  it('extracts the code from a game URL', () => {
    expect(roomCodeFromPath('/game/AB12')).toBe('AB12');
    expect(roomCodeFromPath('/game/AB12/')).toBe('AB12');
  });

  it('returns null for other paths', () => {
    expect(roomCodeFromPath('/')).toBeNull();
    expect(roomCodeFromPath('/game/ab12')).toBeNull();
    expect(roomCodeFromPath('/game/AB12/extra')).toBeNull();
  });
});
