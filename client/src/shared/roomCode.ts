const ROOM_CODE_RE = /^[A-Z0-9]{4}$/;

export function isRoomCode(value: string): boolean {
  return ROOM_CODE_RE.test(value);
}

/** Extracts the room code from a `/game/XXXX` path, or null if the path is not a game URL. */
export function roomCodeFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/game\/([^/]+)\/?$/);
  const code = match?.[1];
  return code !== undefined && isRoomCode(code) ? code : null;
}
