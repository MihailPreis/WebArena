import { describe, expect, it } from 'vitest';
import { heading, headingText, markLabel } from './compass';

describe('heading', () => {
  it('is north when looking along -Z', () => {
    expect(heading(0)).toBe(0);
  });

  it('grows when turning right', () => {
    expect(heading(-Math.PI / 2)).toBeCloseTo(90);
    expect(heading(Math.PI / 2)).toBeCloseTo(270);
    expect(heading(Math.PI)).toBeCloseTo(180);
    expect(heading(-Math.PI)).toBeCloseTo(180);
  });

  it('stays below 360', () => {
    expect(headingText(0.001)).toBe('0');
    expect(headingText(-0.001)).toBe('0');
    expect(headingText(Math.PI / 180)).toBe('359');
  });
});

describe('markLabel', () => {
  it('names the compass points', () => {
    expect(markLabel(0)).toBe('С');
    expect(markLabel(90)).toBe('В');
    expect(markLabel(225)).toBe('ЮЗ');
    expect(markLabel(360)).toBe('С');
  });

  it('shows degrees between the points', () => {
    expect(markLabel(30)).toBe('30');
    expect(markLabel(375)).toBe('15');
  });
});
