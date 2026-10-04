import { ApiError, createPlayer, getMe, type Profile } from './api';

const STORAGE_KEY = 'arena.player';

export interface Session {
  /** Secret: proves who the player is. Never show it or send it to other players. */
  token: string;
  profile: Profile;
}

// localStorage can be unavailable (private mode, blocked site data). The player then
// gets a fresh profile on every visit, but the game still works.
function readToken(): string | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof stored === 'object' && stored !== null && 'token' in stored) {
      return typeof stored.token === 'string' ? stored.token : null;
    }
  } catch {
    // Fall through: treat as a first visit.
  }
  return null;
}

function store(id: string, token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, token }));
  } catch {
    // The profile will not survive a reload.
  }
}

/** Returns the stored player, creating one on the first visit or if the server forgot it. */
export async function ensureSession(): Promise<Session> {
  const token = readToken();
  if (token) {
    try {
      return { token, profile: await getMe(token) };
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
  }
  const { token: newToken, ...profile } = await createPlayer();
  store(profile.id, newToken);
  return { token: newToken, profile };
}
