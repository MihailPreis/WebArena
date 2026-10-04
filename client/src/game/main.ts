import '../style.css';
import './game.css';
import arenaJson from '@shared/maps/arena.json';
import constants from '@shared/constants.json';
import { ApiError, getRoom, isRoomFull, type RoomInfo } from '../shared/api';
import { roomCodeFromPath } from '../shared/roomCode';
import { describeSettings } from '../shared/roomText';
import { ensureSession, type Session } from '../shared/session';
import { GameAudio } from './audio';
import { Hud, type NamedPlayer } from './hud';
import { Input } from './input';
import { Connection } from './net/connection';
import { RemoteInterpolator } from './net/interpolation';
import { Prediction } from './net/prediction';
import {
  CloseCode,
  COMBAT,
  INTERPOLATION_DELAY_S,
  SNAPSHOT_RATE,
  type EventMsg,
  type PublicPlayer,
  type RoomStateMsg,
  type SelfStatus,
  type SnapshotMsg,
  type WelcomeMsg,
} from './net/protocol';
import { createRenderer } from './render/renderer';
import { createViewmodel } from './render/viewmodel';
import { formatClock, Scoreboard } from './scoreboard';
import {
  loadSensitivity,
  loadVolume,
  saveSensitivity,
  saveVolume,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
} from './settings';
import { PLAYER, TICK_DT } from './sim/constants';
import { FixedStep } from './sim/fixedStep';
import { parseMap, type Vec3 } from './sim/map';
import type { InputCmd } from './sim/movement';
import { aimDirection, shotEnd } from './sim/ray';
import { WEAPON } from './sim/weapon';
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
  // The room state can arrive before the game is ready to show it.
  let pendingRoomState: RoomStateMsg | null = null;
  const connection = new Connection(code, session.token, {
    onWelcome(welcome) {
      for (const other of welcome.players) roster.set(other.id, other);
      try {
        game = createGame({ welcome, connection, roster, self: session.profile });
      } catch (error) {
        console.error(error);
        message.textContent = 'Не удалось запустить игру. Проверьте, что в браузере включён WebGL.';
        return;
      }
      message.textContent = '';
      setupCopyLink();
      if (pendingRoomState) game.handleRoomState(pendingRoomState);
    },
    onSnapshot(snapshot) {
      game?.handleSnapshot(snapshot);
    },
    onEvent(event) {
      if (event.e === 'join') roster.set(event.player.id, event.player);
      else if (event.e === 'leave') roster.delete(event.id);
      else game?.handleEvent(event);
    },
    onRoomState(state) {
      element('room-info').textContent = describeSettings(state.settings);
      // The table also lists players who joined before this client did.
      for (const row of state.players) {
        if (row.online && row.id !== session.profile.id) roster.set(row.id, row);
      }
      pendingRoomState = state;
      game?.handleRoomState(state);
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
  self: NamedPlayer;
}

// Distance walked between two footstep sounds.
const STEP_DISTANCE = 2.2;
// How far in front of the camera the gun's muzzle is imagined to be.
const MUZZLE_DISTANCE = 0.5;
const UNKNOWN_PLAYER: NamedPlayer = { name: '?', color: '#ffffff' };

function createGame({ welcome, connection, roster, self }: GameOptions) {
  const canvas = element<HTMLCanvasElement>('view');
  const overlay = element('overlay');
  const hudRoot = element('hud');
  const play = element<HTMLButtonElement>('play');
  const slider = element<HTMLInputElement>('sensitivity');
  const sliderValue = element('sensitivity-value');

  const map = parseMap(arenaJson);
  const renderer = createRenderer(canvas, map);
  window.addEventListener('resize', () => renderer.resize());
  const viewmodel = createViewmodel(element<HTMLCanvasElement>('viewmodel'));
  const hud = new Hud();
  const audio = new GameAudio();

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

  const volume = element<HTMLInputElement>('volume');
  volume.value = String(loadVolume());
  audio.setVolume(Number(volume.value));
  volume.addEventListener('input', () => {
    audio.setVolume(Number(volume.value));
    saveVolume(Number(volume.value));
  });

  // Rules of the next match, editable by the host between matches.
  const hostForm = element<HTMLFormElement>('host-settings');
  const hostKillLimit = element<HTMLInputElement>('host-kill-limit');
  const hostTimeLimit = element<HTMLInputElement>('host-time-limit');
  const hostApply = element<HTMLButtonElement>('host-apply');
  const hostNote = element('host-note');
  hostKillLimit.min = String(constants.room.killLimit.min);
  hostKillLimit.max = String(constants.room.killLimit.max);
  hostTimeLimit.min = String(constants.room.timeLimitMin.min);
  hostTimeLimit.max = String(constants.room.timeLimitMin.max);
  hostForm.addEventListener('submit', (event) => {
    event.preventDefault();
    connection.sendSettings(hostKillLimit.valueAsNumber, hostTimeLimit.valueAsNumber);
  });

  const scoreboard = new Scoreboard(element('scoreboard'), welcome.id);
  const matchLine = element('match');
  let roomState: RoomStateMsg | null = null;
  let roomStateAt = 0;

  let running = true;
  const input = new Input(
    canvas,
    () => sensitivity,
    (locked) => {
      overlay.hidden = locked;
      hudRoot.hidden = !locked;
    },
  );
  input.yaw = welcome.you.yaw;
  const lock = () => {
    if (!running) return;
    audio.resume();
    input.lock();
  };
  play.addEventListener('click', lock);
  canvas.addEventListener('click', lock);
  for (const id of ['play', 'controls', 'sensitivity-row', 'volume-row']) {
    element(id).hidden = false;
  }

  const myId = welcome.id;
  const lookup = (id: string): NamedPlayer =>
    id === myId ? self : (roster.get(id) ?? UNKNOWN_PLAYER);

  const loop = new FixedStep(TICK_DT);
  const view = new ViewSmoother();
  const prediction = new Prediction(map, welcome.you, welcome.status);
  const remotes = new RemoteInterpolator(INTERPOLATION_DELAY_S);
  let status: SelfStatus = welcome.status;
  let others: (NamedPlayer & { id: string; pos: Vec3; yaw: number; crouched: boolean })[] = [];
  let killer: NamedPlayer | null = null;
  let diedAt = 0;
  let stride = 0;
  let nextStep = STEP_DISTANCE;
  let wasReloading = false;
  const remoteSteps = new Map<string, { pos: Vec3; walked: number }>();

  function eyeOf(pos: Vec3, crouched: boolean): Vec3 {
    return [pos[0], pos[1] + (crouched ? PLAYER.crouchEyeHeight : PLAYER.standEyeHeight), pos[2]];
  }

  function fire(cmd: InputCmd): void {
    const origin = eyeOf(prediction.current.pos, prediction.current.crouched);
    const direction = aimDirection(cmd.yaw, cmd.pitch);
    const end = shotEnd(map, origin, direction, others);
    // Start the tracer at the tip of the barrel as drawn on screen, not between the eyes.
    const barrel = viewmodel.muzzle();
    renderer.addTracer(renderer.screenToWorld(barrel.x, barrel.y, MUZZLE_DISTANCE), end);
    viewmodel.fire();
    audio.shot(null);
  }

  function footsteps(): void {
    const state = prediction.current;
    const before = prediction.previous;
    if (prediction.active && state.onGround) {
      stride += Math.hypot(state.pos[0] - before.pos[0], state.pos[2] - before.pos[2]);
      if (stride >= nextStep) {
        nextStep = stride + STEP_DISTANCE;
        if (!state.crouched) audio.step(null);
      }
    }
  }

  function remoteFootsteps(): void {
    for (const other of others) {
      const track = remoteSteps.get(other.id);
      if (!track) {
        remoteSteps.set(other.id, { pos: other.pos, walked: 0 });
        continue;
      }
      const moved = Math.hypot(other.pos[0] - track.pos[0], other.pos[2] - track.pos[2]);
      // Falling, jumping and respawning are not steps.
      const level = Math.abs(other.pos[1] - track.pos[1]) < 0.02;
      track.pos = other.pos;
      if (moved > 1 || !level) continue;
      track.walked += moved;
      if (track.walked >= STEP_DISTANCE) {
        track.walked = 0;
        if (!other.crouched) audio.step(other.pos);
      }
    }
    for (const id of remoteSteps.keys()) {
      if (!others.some((other) => other.id === id)) remoteSteps.delete(id);
    }
  }

  let lastTime = performance.now();
  let fps = 0;
  function frame(now: number): void {
    // A background tab can pause for seconds; do not replay that time.
    const dt = Math.min((now - lastTime) / 1000, 0.25);
    lastTime = now;
    const seconds = now / 1000;

    others = remotes.sample(seconds).map((remote) => ({ ...remote, ...lookup(remote.id) }));
    const renderTime = remotes.renderTime(seconds);

    const steps = running ? loop.advance(dt) : 0;
    for (let i = 0; i < steps; i++) {
      const cmd = input.command();
      const { seq, fired } = prediction.step(cmd);
      connection.sendInput(seq, cmd, renderTime);
      if (fired) fire(cmd);
      footsteps();
    }
    remoteFootsteps();

    const reloading = prediction.weapon.reload > 0;
    if (reloading && !wasReloading) audio.reload();
    wasReloading = reloading;

    const dead = !status.alive;
    const camera = view.update(
      prediction.previous,
      prediction.current,
      loop.alpha,
      input.yaw,
      input.pitch,
      dt,
      dead,
    );
    audio.setListener(camera.eye, input.yaw);
    renderer.render(camera, others, dt);
    viewmodel.update(dt, stride, reloading || dead);

    hud.setHealth(status.hp);
    hud.setAmmo(prediction.weapon.ammo, WEAPON.magazine, reloading);
    hud.setDeath(
      dead ? (killer ?? UNKNOWN_PLAYER) : null,
      COMBAT.respawnDelayS - (now - diedAt) / 1000,
    );

    if (roomState) {
      const timeLeft =
        roomState.timeLeft === null ? null : roomState.timeLeft - (now - roomStateAt) / 1000;
      const results = roomState.state === 'results';
      scoreboard.visible = results || input.isDown('Tab');
      scoreboard.update(roomState, timeLeft);
      const mine = roomState.players.find((row) => row.id === myId);
      if (roomState.state === 'waiting') matchLine.textContent = 'Ожидание игроков';
      else if (results) matchLine.textContent = 'Матч окончен';
      else {
        matchLine.textContent = `${formatClock(timeLeft ?? 0)} · ${mine?.kills ?? 0} / ${roomState.settings.killLimit}`;
      }
    }

    if (dt > 0) fps += (1 / dt - fps) * 0.05;
    const speed = Math.hypot(prediction.current.vel[0], prediction.current.vel[2]);
    const ping = connection.ping === null ? '—' : connection.ping.toFixed(0);
    hud.setDebug(
      [
        `${fps.toFixed(0)} fps`,
        `${ping} мс`,
        `${speed.toFixed(1)} м/с`,
        `игроков: ${roster.size + 1}`,
      ].join('\n'),
    );
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    handleSnapshot(snapshot: SnapshotMsg): void {
      status = snapshot.status;
      remotes.push(snapshot.tick / SNAPSHOT_RATE, performance.now() / 1000, snapshot.players);
      view.nudge(prediction.reconcile(snapshot.you, snapshot.status, snapshot.ack));
    },
    handleRoomState(state: RoomStateMsg): void {
      const previous = roomState;
      roomState = state;
      roomStateAt = performance.now();

      const isHost = state.hostId === myId;
      const editable = state.state !== 'match';
      hostForm.hidden = !isHost;
      hostKillLimit.disabled = hostTimeLimit.disabled = hostApply.disabled = !editable;
      hostNote.textContent = editable
        ? 'Изменения действуют со следующего матча.'
        : 'Параметры можно менять между матчами.';
      // Do not overwrite what the host is typing with every periodic update.
      const changed =
        previous?.settings.killLimit !== state.settings.killLimit ||
        previous.settings.timeLimitMin !== state.settings.timeLimitMin;
      if (changed) {
        hostKillLimit.value = String(state.settings.killLimit);
        hostTimeLimit.value = String(state.settings.timeLimitMin);
      }
    },
    handleEvent(event: EventMsg): void {
      switch (event.e) {
        case 'shot':
          renderer.addTracer([event.from[0], event.from[1] - 0.14, event.from[2]], event.to);
          audio.shot(event.from);
          break;
        case 'hit':
          if (event.by === myId) {
            hud.hitMarker(event.head);
            audio.hitConfirm(event.head);
          }
          if (event.target === myId) {
            const [x, , z] = prediction.current.pos;
            // Yaw of the direction to the attacker, relative to where the player looks.
            const toAttacker = Math.atan2(x - event.from[0], z - event.from[2]);
            hud.damageFrom(input.yaw - toAttacker);
            audio.hurt();
          }
          break;
        case 'kill':
          hud.addKill(lookup(event.by), lookup(event.target), event.head);
          if (event.target === myId) {
            killer = lookup(event.by);
            diedAt = performance.now();
            audio.death(null);
          } else {
            const victim = others.find((other) => other.id === event.target);
            audio.death(victim?.pos ?? null);
            if (event.by === myId) hud.hitMarker(true);
          }
          break;
        case 'spawn':
          if (event.id === myId) {
            input.yaw = event.yaw;
            input.pitch = 0;
            view.reset();
          }
          break;
      }
    },
    /** Freezes the game after the connection is gone; the last frame stays on screen. */
    stop(): void {
      running = false;
      play.hidden = true;
      if (document.pointerLockElement) document.exitPointerLock();
    },
  };
}
