export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`API request failed with status ${status}`);
  }
}

export interface Profile {
  id: string;
  name: string;
  color: string;
}

export interface RoomSettings {
  mode: string;
  killLimit: number;
  timeLimitMin: number;
  maxPlayers: number;
}

export interface RoomInfo {
  code: string;
  hostId: string;
  players: number;
  settings: RoomSettings;
}

export type LeaderboardKind = 'kd' | 'kills' | 'wins';

export interface LeaderboardRow extends Profile {
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  kd: number;
}

export interface Leaderboard {
  by: LeaderboardKind;
  /** Kills a player needs before appearing in the K/D ranking. */
  minKills: number;
  players: LeaderboardRow[];
}

export interface PlayerStats extends LeaderboardRow {
  headshots: number;
  shots: number;
  hits: number;
  /** Share of shots that hit, 0 to 1. */
  accuracy: number;
  damageDealt: number;
  playtimeS: number;
}

interface RequestOptions {
  method?: string;
  token?: string;
  body?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) throw new ApiError(response.status);
  return (await response.json()) as T;
}

export const createPlayer = () =>
  request<Profile & { token: string }>('/api/players', { method: 'POST' });

export const getMe = (token: string) => request<Profile>('/api/players/me', { token });

export const updateMe = (token: string, update: Partial<Pick<Profile, 'name' | 'color'>>) =>
  request<Profile>('/api/players/me', { method: 'PATCH', token, body: update });

export const createRoom = (token: string, settings: RoomSettings) =>
  request<RoomInfo>('/api/rooms', { method: 'POST', token, body: settings });

export const getRoom = (code: string) => request<RoomInfo>(`/api/rooms/${code}`);

export const getLeaderboard = (by: LeaderboardKind) =>
  request<Leaderboard>(`/api/leaderboard?by=${by}`);

export const getPlayerStats = (id: string) => request<PlayerStats>(`/api/players/${id}`);

export function isRoomFull(room: RoomInfo): boolean {
  return room.players >= room.settings.maxPlayers;
}
