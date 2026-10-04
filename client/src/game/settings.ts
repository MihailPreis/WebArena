const SENSITIVITY_KEY = 'arena.sensitivity';

export const SENSITIVITY_MIN = 0.1;
export const SENSITIVITY_MAX = 3;
export const SENSITIVITY_DEFAULT = 1;

// localStorage can be unavailable (private mode, blocked site data); the game must still run.
export function loadSensitivity(): number {
  try {
    const value = Number(localStorage.getItem(SENSITIVITY_KEY));
    if (value >= SENSITIVITY_MIN && value <= SENSITIVITY_MAX) return value;
  } catch {
    // Fall through to the default.
  }
  return SENSITIVITY_DEFAULT;
}

export function saveSensitivity(value: number): void {
  try {
    localStorage.setItem(SENSITIVITY_KEY, String(value));
  } catch {
    // The setting simply will not persist.
  }
}
