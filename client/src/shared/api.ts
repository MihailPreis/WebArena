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

export function isRoomFull(room: RoomInfo): boolean {
  return room.players >= room.settings.maxPlayers;
}
