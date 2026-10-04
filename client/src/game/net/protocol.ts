// Wire protocol. Mirrors server/arena/net/protocol.py — change both together.
import constants from '@shared/constants.json';
import type { Vec3 } from '../sim/map';
import type { InputCmd, PlayerState } from '../sim/movement';

export const PROTOCOL_VERSION = constants.net.protocolVersion;
export const SNAPSHOT_RATE = constants.net.snapshotRate;
export const INTERPOLATION_DELAY_S = constants.net.interpolationDelayMs / 1000;
export const COMBAT = constants.combat;

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

/** The private part of the player's own state. */
export interface SelfStatus {
  hp: number;
  alive: boolean;
  ammo: number;
  cooldown: number;
  reload: number;
}

export interface WelcomeMsg {
  t: 'welcome';
  v: number;
  id: string;
  tick: number;
  map: string;
  you: PlayerState;
  status: SelfStatus;
  players: PublicPlayer[];
}

export interface SnapshotMsg {
  t: 'snapshot';
  tick: number;
  /** Sequence number of the last input the server has simulated; -1 if none. */
  ack: number;
  you: PlayerState;
  status: SelfStatus;
  /** Living players other than the receiver. */
  players: RemoteState[];
}

export type EventMsg =
  | { t: 'event'; e: 'join'; player: PublicPlayer }
  | { t: 'event'; e: 'leave'; id: string }
  /** Someone else fired; `from` is their eye, `to` is where the shot stopped. */
  | { t: 'event'; e: 'shot'; id: string; from: Vec3; to: Vec3 }
  /** Sent to the shooter and the target only; `from` is the shooter's position. */
  | { t: 'event'; e: 'hit'; by: string; target: string; dmg: number; head: boolean; from: Vec3 }
  | { t: 'event'; e: 'kill'; by: string; target: string; head: boolean }
  | { t: 'event'; e: 'spawn'; id: string; yaw: number };

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
      fire: boolean;
      reload: boolean;
      /** Server time the client is drawing other players at, for lag compensation. */
      rt: number;
    }
  | { t: 'ping'; id: number };

export function inputMessage(seq: number, cmd: InputCmd, renderTime: number): ClientMessage {
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
    fire: cmd.fire,
    reload: cmd.reload,
    rt: renderTime,
  };
}
