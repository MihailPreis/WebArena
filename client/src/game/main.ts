import '../style.css';
import './game.css';
import arenaJson from '@shared/maps/arena.json';
import { ApiError, getRoom, isRoomFull, type RoomInfo } from '../shared/api';
import { roomCodeFromPath } from '../shared/roomCode';
import { describeSettings } from '../shared/roomText';
import { ensureSession, type Session } from '../shared/session';
import { Input } from './input';
import { Connection } from './net/connection';
import { RemoteInterpolator } from './net/interpolation';
import { Prediction } from './net/prediction';
import {
  CloseCode,
  INTERPOLATION_DELAY_S,
  SNAPSHOT_RATE,
  type PublicPlayer,
  type SnapshotMsg,
  type WelcomeMsg,
} from './net/protocol';
import { createRenderer } from './render/renderer';
import { loadSensitivity, saveSensitivity, SENSITIVITY_MAX, SENSITIVITY_MIN } from './settings';
import { TICK_DT } from './sim/constants';
import { FixedStep } from './sim/fixedStep';
import { parseMap } from './sim/map';
import { ViewSmoother } from './view';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} element is missing`);
  return found as T;
}

const title = element('room-title');
const message = element('message');

const CLOSE_MESSAGES: Record<number, string> = {
  [CloseCode.ROOM_FULL]: 'Комната заполнена.',
  [CloseCode.ROOM_NOT_FOUND]: 'Комната закрылась. Создайте новую на главной.',
  [CloseCode.REPLACED]: 'Игра открыта в другой вкладке.',
  [CloseCode.VERSION_MISMATCH]: 'Вышла новая версия игры. Обновите страницу.',
  [CloseCode.BAD_TOKEN]: 'Профиль не найден. Обновите страницу.',
};

async function enter(): Promise<void> {
  const code = roomCodeFromPath(window.location.pathname);
  if (!code) {
    title.textContent = 'Комната не найдена';
    message.textContent = 'Проверьте ссылку: код комнаты — 4 латинские буквы или цифры.';
    return;
  }
  title.textContent = `Комната ${code}`;

  let session: Session;
  let room: RoomInfo;
  try {
    // A visitor who came by an invite link gets a profile here, with the default name.
    [session, room] = await Promise.all([ensureSession(), getRoom(code)]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      title.textContent = 'Комната не найдена';
      message.textContent = 'Возможно, она закрылась. Создайте новую на главной.';
    } else {
      console.error(error);
      message.textContent = 'Сервер недоступен. Попробуйте обновить страницу.';
    }
    return;
  }
  if (isRoomFull(room)) {
    title.textContent = 'Комната заполнена';
    message.textContent = `В комнате ${code} нет свободных мест.`;
    return;
  }

  message.textContent = 'Подключение…';
  element('room-info').textContent = describeSettings(room.settings);
  const player = element('player');
  player.textContent = session.profile.name;
  player.style.color = session.profile.color;

  const roster = new Map<string, PublicPlayer>();
  let game: ReturnType<typeof createGame> | null = null;
  const connection = new Connection(code, session.token, {
    onWelcome(welcome) {
      for (const other of welcome.players) roster.set(other.id, other);
      try {
        game = createGame({ welcome, connection, roster });
      } catch (error) {
        console.error(error);
        message.textContent = 'Не удалось запустить игру. Проверьте, что в браузере включён WebGL.';
        return;
      }
      message.textContent = '';
      setupCopyLink();
    },
    onSnapshot(snapshot) {
      game?.handleSnapshot(snapshot);
    },
    onEvent(event) {
      if (event.e === 'join') roster.set(event.player.id, event.player);
      else roster.delete(event.id);
    },
    onClose(closeCode) {
      game?.stop();
      message.textContent =
        CLOSE_MESSAGES[closeCode] ?? 'Соединение потеряно. Обновите страницу, чтобы вернуться.';
    },
  });
}

function setupCopyLink(): void {
  const button = element<HTMLButtonElement>('copy-link');
  const label = button.textContent;
  button.hidden = false;
  button.addEventListener('click', () => {
    const url = window.location.origin + window.location.pathname;
    navigator.clipboard.writeText(url).then(
      () => (button.textContent = 'Ссылка скопирована'),
      // Clipboard access can be denied; show the link so it can be copied by hand.
      () => (message.textContent = url),
    );
    window.setTimeout(() => (button.textContent = label), 2000);
  });
}

void enter();

interface GameOptions {
  welcome: WelcomeMsg;
  connection: Connection;
  /** Names and colours of the other players; kept up to date by the caller. */
  roster: ReadonlyMap<string, PublicPlayer>;
}

function createGame({ welcome, connection, roster }: GameOptions) {
  const canvas = element<HTMLCanvasElement>('view');
  const overlay = element('overlay');
  const hud = element('hud');
  const debug = element('debug');
  const play = element<HTMLButtonElement>('play');
  const slider = element<HTMLInputElement>('sensitivity');
  const sliderValue = element('sensitivity-value');

  const map = parseMap(arenaJson);
  const renderer = createRenderer(canvas, map);
  window.addEventListener('resize', () => renderer.resize());

  let sensitivity = loadSensitivity();
  slider.min = String(SENSITIVITY_MIN);
  slider.max = String(SENSITIVITY_MAX);
  slider.value = String(sensitivity);
  sliderValue.textContent = sensitivity.toFixed(2);
  slider.addEventListener('input', () => {
    sensitivity = Number(slider.value);
    sliderValue.textContent = sensitivity.toFixed(2);
    saveSensitivity(sensitivity);
  });

  let running = true;
  const input = new Input(
    canvas,
    () => sensitivity,
    (locked) => {
      overlay.hidden = locked;
      hud.hidden = !locked;
    },
  );
  input.yaw = welcome.you.yaw;
  const lock = () => {
    if (running) input.lock();
  };
  play.addEventListener('click', lock);
  canvas.addEventListener('click', lock);
  for (const id of ['play', 'controls', 'sensitivity-row']) element(id).hidden = false;

  const loop = new FixedStep(TICK_DT);
  const view = new ViewSmoother();
  const prediction = new Prediction(map, welcome.you);
  const remotes = new RemoteInterpolator(INTERPOLATION_DELAY_S);

  let lastTime = performance.now();
  let fps = 0;
  function frame(now: number): void {
    // A background tab can pause for seconds; do not replay that time.
    const dt = Math.min((now - lastTime) / 1000, 0.25);
    lastTime = now;

    const steps = running ? loop.advance(dt) : 0;
    for (let i = 0; i < steps; i++) {
      const cmd = input.command();
      connection.sendInput(prediction.step(cmd), cmd);
    }

    const others = remotes.sample(now / 1000).map((remote) => {
      const known = roster.get(remote.id);
      return { ...remote, name: known?.name ?? '', color: known?.color ?? '#ffffff' };
    });
    renderer.render(
      view.update(prediction.previous, prediction.current, loop.alpha, input.yaw, input.pitch, dt),
      others,
    );

    if (dt > 0) fps += (1 / dt - fps) * 0.05;
    const speed = Math.hypot(prediction.current.vel[0], prediction.current.vel[2]);
    const ping = connection.ping === null ? '—' : connection.ping.toFixed(0);
    debug.textContent = [
      `${fps.toFixed(0)} fps`,
      `${ping} мс`,
      `${speed.toFixed(1)} м/с`,
      `игроков: ${others.length + 1}`,
    ].join('\n');
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    handleSnapshot(snapshot: SnapshotMsg): void {
      remotes.push(snapshot.tick / SNAPSHOT_RATE, performance.now() / 1000, snapshot.players);
      view.nudge(prediction.reconcile(snapshot.you, snapshot.ack));
    },
    /** Freezes the game after the connection is gone; the last frame stays on screen. */
    stop(): void {
      running = false;
      play.hidden = true;
      if (document.pointerLockElement) document.exitPointerLock();
    },
  };
}
