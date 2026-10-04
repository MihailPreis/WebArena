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

const VOLUME_KEY = 'arena.volume';
export const VOLUME_DEFAULT = 0.5;

export function loadVolume(): number {
  try {
    const stored = localStorage.getItem(VOLUME_KEY);
    const value = Number(stored);
    if (stored !== null && value >= 0 && value <= 1) return value;
  } catch {
    // Fall through to the default.
  }
  return VOLUME_DEFAULT;
}

export function saveVolume(value: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(value));
  } catch {
    // The setting simply will not persist.
  }
}

export function saveSensitivity(value: number): void {
  try {
    localStorage.setItem(SENSITIVITY_KEY, String(value));
  } catch {
    // The setting simply will not persist.
  }
}
