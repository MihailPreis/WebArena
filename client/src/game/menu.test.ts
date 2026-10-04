import { describe, expect, it } from 'vitest';
import { canSwitch } from './menu';

describe('canSwitch', () => {
  it('allows a move that keeps the sides within one player', () => {
    expect(canSwitch({ blue: 3, red: 1 }, 'blue', 'red')).toBe(true);
    expect(canSwitch({ blue: 2, red: 1 }, 'blue', 'red')).toBe(true);
  });

  it('refuses a move that would leave the sides uneven', () => {
    expect(canSwitch({ blue: 1, red: 1 }, 'blue', 'red')).toBe(false);
    expect(canSwitch({ blue: 1, red: 2 }, 'blue', 'red')).toBe(false);
  });

  it('refuses a move to the same side', () => {
    expect(canSwitch({ blue: 3, red: 1 }, 'blue', 'blue')).toBe(false);
  });
});
