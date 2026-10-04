import constants from '@shared/constants.json';
import type { RoomSettings } from './api';

export type Team = 'blue' | 'red';
export const TEAMS: Team[] = ['blue', 'red'];
export const TEAM_NAMES: Record<Team, string> = { blue: 'Синие', red: 'Красные' };
export const TEAM_COLORS: Record<Team, string> = {
  blue: constants.teams.blue.color,
  red: constants.teams.red.color,
};

const MODE_NAMES: Record<string, string> = {
  deathmatch: 'Deathmatch',
  'team-deathmatch': 'Team Deathmatch',
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
