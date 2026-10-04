const POINTS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];

/** Degrees between two neighbouring marks of the compass strip. */
export const MARK_STEP = 15;

/**
 * Compass heading in degrees, from 0 up to 360: 0 is north (towards −Z), 90 is east
 * (towards +X). Yaw grows when turning left, the heading when turning right.
 */
export function heading(yaw: number): number {
  const degrees = (-yaw * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

/** What is written at a mark: a compass point every 45 degrees, the number otherwise. */
export function markLabel(degrees: number): string {
  const whole = ((Math.round(degrees) % 360) + 360) % 360;
  return whole % 45 === 0 ? (POINTS[whole / 45] ?? '') : String(whole);
}

/** The heading as shown in the middle of the compass: whole degrees, 0–359. */
export function headingText(yaw: number): string {
  return String(Math.round(heading(yaw)) % 360);
}
