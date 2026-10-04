import type { InputCmd } from '../sim/movement';
import {
  inputMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type EventMsg,
  type RoomStateMsg,
  type ServerMessage,
  type SnapshotMsg,
  type WelcomeMsg,
} from './protocol';

const PING_INTERVAL_MS = 2000;

export interface ConnectionHandlers {
  onWelcome(message: WelcomeMsg): void;
  onSnapshot(message: SnapshotMsg): void;
  onEvent(message: EventMsg): void;
  onRoomState(message: RoomStateMsg): void;
  /** `code` is a WebSocket close code; see `CloseCode` for the server's own. */
  onClose(code: number): void;
}

/** One WebSocket session with a room. Does not reconnect. */
export class Connection {
  /** Round-trip time of the latest ping in milliseconds, or null before the first reply. */
  ping: number | null = null;
  private readonly socket: WebSocket;
  private pingTimer = 0;
  private pingId = 0;
  private pingSentAt = 0;

  constructor(code: string, token: string, handlers: ConnectionHandlers) {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    this.socket = new WebSocket(`${scheme}://${window.location.host}/ws/${code}`);

    this.socket.addEventListener('open', () => {
      // The token goes in a message, not the URL, so it stays out of server and proxy logs.
      this.send({ t: 'hello', v: PROTOCOL_VERSION, token });
      this.pingTimer = window.setInterval(() => {
        this.pingSentAt = performance.now();
        this.send({ t: 'ping', id: ++this.pingId, rtt: Math.round(this.ping ?? 0) });
      }, PING_INTERVAL_MS);
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      switch (message.t) {
        case 'snapshot':
          handlers.onSnapshot(message);
          break;
        case 'welcome':
          handlers.onWelcome(message);
          break;
        case 'event':
          handlers.onEvent(message);
          break;
        case 'room':
          handlers.onRoomState(message);
          break;
        case 'pong':
          if (message.id === this.pingId) this.ping = performance.now() - this.pingSentAt;
          break;
      }
    });
    this.socket.addEventListener('close', (event) => {
      window.clearInterval(this.pingTimer);
      handlers.onClose(event.code);
    });
  }

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  sendInput(seq: number, cmd: InputCmd, renderTime: number): void {
    this.send(inputMessage(seq, cmd, renderTime));
  }

  /** Asks the server to change the rules; it only obeys the host, between matches. */
  sendSettings(killLimit: number, timeLimitMin: number): void {
    this.send({ t: 'settings', killLimit, timeLimitMin });
  }

  private send(message: ClientMessage): void {
    if (this.open) this.socket.send(JSON.stringify(message));
  }
}
