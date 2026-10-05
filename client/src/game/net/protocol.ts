// Wire protocol. Mirrors server/arena/net/protocol.py — change both together.
import constants from '@shared/constants.json';
import type { Team } from '../../shared/roomText';
import type { Vec3 } from '../sim/map';

export type { Team };
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
  TOO_FAST: 4007,
  TOO_MANY_CONNECTIONS: 4008,
} as const;

export interface PublicPlayer {
  id: string;
  name: string;
  color: string;
  /** Side in a team mode; null in a free-for-all. */
  team: Team | null;
}

export interface RemoteState {
  id: string;
  pos: Vec3;
  yaw: number;
  crouched: boolean;
  dashing: boolean;
  /** Carries the damage booster. */
  quad: boolean;
}

/** The private part of the player's own state. */
export interface SelfStatus {
  hp: number;
  armor: number;
  alive: boolean;
  /** The match is over and the results are shown: nobody can move or shoot. */
  frozen: boolean;
  /** Index of the weapon in hand. */
  weapon: number;
  /** Rounds left for each weapon. */
  ammo: number[];
  /** Bit `i` is set when weapon `i` has been picked up. */
  owned: number;
  cooldown: number;
  /** Seconds of the damage booster left. */
  quad: number;
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
  /** Bit `i` is set while item `i` of the map is there to be picked up. */
  items: number;
}

export type EventMsg =
  | { t: 'event'; e: 'join'; player: PublicPlayer }
  | { t: 'event'; e: 'leave'; id: string }
  /** Someone else fired weapon `w`; `from` is their eye, `to` is where each pellet stopped. */
  | { t: 'event'; e: 'shot'; id: string; w: number; from: Vec3; to: Vec3[] }
  /** Rocket number `n` was launched by player `id`. The shooter gets this too. */
  | { t: 'event'; e: 'rocket'; n: number; id: string; from: Vec3; dir: Vec3 }
  /** Rocket number `n` blew up. */
  | { t: 'event'; e: 'explode'; n: number; pos: Vec3 }
  /** Player `id` took item number `item` of the map. */
  | { t: 'event'; e: 'pickup'; id: string; item: number }
  /** Sent to the attacker and the target only; `from` is where the damage came from. */
  | { t: 'event'; e: 'hit'; by: string; target: string; dmg: number; head: boolean; from: Vec3 }
  /** `by` equals `target` when a player died by their own rocket. */
  | { t: 'event'; e: 'kill'; by: string; target: string; head: boolean }
  | { t: 'event'; e: 'spawn'; id: string; yaw: number }
  /** A player switched sides. */
  | { t: 'event'; e: 'team'; id: string; team: Team }
  /** A line of chat; everyone in the room gets it, the sender included. */
  | { t: 'event'; e: 'chat'; id: string; text: string };

export interface ScoreRow extends PublicPlayer {
  kills: number;
  deaths: number;
  /** Round-trip time in milliseconds. */
  ping: number;
  /** False for a player who left during the match; they stay in the table until it ends. */
  online: boolean;
}

export type RoomState = 'waiting' | 'match' | 'results';

/** Match state, rules and the score table. Sent on every change and every couple of seconds. */
export interface RoomStateMsg {
  t: 'room';
  state: RoomState;
  /** Seconds until the current state ends; null while waiting for players. */
  timeLeft: number | null;
  hostId: string;
  /** Score of each team; null when the mode has no teams. */
  teams: Record<Team, number> | null;
  settings: { mode: string; killLimit: number; timeLimitMin: number; maxPlayers: number };
  /** Ordered from first place to last. */
  players: ScoreRow[];
}

export interface PongMsg {
  t: 'pong';
  id: number;
}

export type ServerMessage = WelcomeMsg | SnapshotMsg | EventMsg | RoomStateMsg | PongMsg;

export type ClientMessage =
  | { t: 'hello'; v: number; token: string }
  | {
      t: 'input';
      seq: number;
      f: number;
      r: number;
      j: boolean;
      c: boolean;
      d: boolean;
      yaw: number;
      pitch: number;
      fire: boolean;
      /** Index of the weapon the player wants in hand. */
      w: number;
      /** Server time the client is drawing other players at, for lag compensation. */
      rt: number;
    }
  | { t: 'ping'; id: number; rtt: number }
  | { t: 'settings'; mode: string; killLimit: number; timeLimitMin: number }
  | { t: 'team'; team: Team }
  | { t: 'chat'; text: string };

export function inputMessage(seq: number, cmd: InputCmd, renderTime: number): ClientMessage {
  return {
    t: 'input',
    seq,
    f: cmd.forward,
    r: cmd.right,
    j: cmd.jump,
    c: cmd.crouch,
    d: cmd.dash,
    yaw: cmd.yaw,
    pitch: cmd.pitch,
    fire: cmd.fire,
    w: cmd.weapon,
    rt: renderTime,
  };
}
