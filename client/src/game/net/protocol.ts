// Wire protocol. Mirrors server/arena/net/protocol.py — change both together.
import constants from '@shared/constants.json';
import type { Vec3 } from '../sim/map';
import type { InputCmd, PlayerState } from '../sim/movement';

export const PROTOCOL_VERSION = constants.net.protocolVersion;
export const SNAPSHOT_RATE = constants.net.snapshotRate;
export const INTERPOLATION_DELAY_S = constants.net.interpolationDelayMs / 1000;

export const CloseCode = {
  BAD_MESSAGE: 4000,
  BAD_TOKEN: 4001,
  ROOM_FULL: 4002,
  ROOM_NOT_FOUND: 4003,
  VERSION_MISMATCH: 4004,
  REPLACED: 4005,
  TOO_SLOW: 4006,
} as const;

export interface PublicPlayer {
  id: string;
  name: string;
  color: string;
}

export interface RemoteState {
  id: string;
  pos: Vec3;
  yaw: number;
  crouched: boolean;
}

export interface WelcomeMsg {
  t: 'welcome';
  v: number;
  id: string;
  tick: number;
  map: string;
  you: PlayerState;
  players: PublicPlayer[];
}

export interface SnapshotMsg {
  t: 'snapshot';
  tick: number;
  /** Sequence number of the last input the server has simulated; -1 if none. */
  ack: number;
  you: PlayerState;
  players: RemoteState[];
}

export type EventMsg =
  { t: 'event'; e: 'join'; player: PublicPlayer } | { t: 'event'; e: 'leave'; id: string };

export interface PongMsg {
  t: 'pong';
  id: number;
}

export type ServerMessage = WelcomeMsg | SnapshotMsg | EventMsg | PongMsg;

export type ClientMessage =
  | { t: 'hello'; v: number; token: string }
  | {
      t: 'input';
      seq: number;
      f: number;
      r: number;
      j: boolean;
      c: boolean;
      s: boolean;
      yaw: number;
      pitch: number;
    }
  | { t: 'ping'; id: number };

export function inputMessage(seq: number, cmd: InputCmd): ClientMessage {
  return {
    t: 'input',
    seq,
    f: cmd.forward,
    r: cmd.right,
    j: cmd.jump,
    c: cmd.crouch,
    s: cmd.sprint,
    yaw: cmd.yaw,
    pitch: cmd.pitch,
  };
}
