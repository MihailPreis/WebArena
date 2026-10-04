import type { RoomSettings } from './api';

const MODE_NAMES: Record<string, string> = {
  deathmatch: 'Deathmatch',
};

export function modeName(mode: string): string {
  return MODE_NAMES[mode] ?? mode;
}

/** One-line summary of match settings, e.g. for the room menu. */
export function describeSettings(settings: RoomSettings): string {
  return [
    modeName(settings.mode),
    `до ${settings.killLimit} убийств`,
    `${settings.timeLimitMin} мин`,
    `до ${settings.maxPlayers} игроков`,
  ].join(' · ');
}
