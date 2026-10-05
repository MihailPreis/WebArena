import '../style.css';
import './game.css';
import constants from '@shared/constants.json';
import { ApiError, getRoom, isRoomFull, type RoomInfo } from '../shared/api';
import { roomCodeFromPath } from '../shared/roomCode';
import {
  availableMaps,
  describeSettings,
  mapName,
  modeName,
  TEAM_COLORS,
  TEAM_NAMES,
  type Team,
} from '../shared/roomText';
import { ensureSession, type Session } from '../shared/session';
import { GameAudio } from './audio';
import { Chat } from './chat';
import { Hud, type MatchSide, type NamedPlayer, type TeammateTag } from './hud';
import { Input } from './input';
import { itemKind, itemLabel } from './labels';
import { loadMap } from './maps';
import { Menu } from './menu';
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
import type { Vec3 } from './sim/map';
import { dashReadiness, type InputCmd } from './sim/movement';
import { aimDirection, pelletDirections, shotEnd } from './sim/ray';
import { usable, WEAPONS, type WeaponState } from './sim/weapon';
import { ViewSmoother } from './view';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} element is missing`);
  return found as T;
}

const title = element('room-title');
const message = element('message');
const roomInfo = element('room-info');

// The line above the menu title. Once the title turns into "Пауза", the room moves here.
let roomLabel = '';
let roomSettings: RoomInfo['settings'] | null = null;
let paused = false;
function showRoomInfo(): void {
  const rules = roomSettings ? describeSettings(roomSettings) : '';
  roomInfo.textContent = paused ? `${roomLabel} · ${rules}` : rules;
}

const CLOSE_MESSAGES: Record<number, string> = {
  [CloseCode.ROOM_FULL]: 'Комната заполнена.',
  [CloseCode.ROOM_NOT_FOUND]: 'Комната закрылась. Создайте новую на главной.',
  [CloseCode.REPLACED]: 'Игра открыта в другой вкладке.',
  [CloseCode.VERSION_MISMATCH]: 'Вышла новая версия игры. Обновите страницу.',
  [CloseCode.BAD_TOKEN]: 'Профиль не найден. Обновите страницу.',
  [CloseCode.TOO_MANY_CONNECTIONS]: 'Слишком много подключений с вашего адреса.',
};

// Close codes after which trying again cannot help.
const FINAL_CLOSE_CODES = new Set<number>([
  CloseCode.BAD_MESSAGE,
  CloseCode.BAD_TOKEN,
  CloseCode.ROOM_FULL,
  CloseCode.ROOM_NOT_FOUND,
  CloseCode.VERSION_MISMATCH,
  CloseCode.REPLACED,
  CloseCode.TOO_FAST,
  CloseCode.TOO_MANY_CONNECTIONS,
]);
const MAX_RECONNECT_ATTEMPTS = 6;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;

async function enter(): Promise<void> {
  const code = roomCodeFromPath(window.location.pathname);
  if (!code) {
    title.textContent = 'Комната не найдена';
    message.textContent = 'Проверьте ссылку: код комнаты — 4 латинские буквы или цифры.';
    return;
  }
  roomLabel = `Комната ${code}`;
  title.textContent = roomLabel;
  // A constant, so that callbacks below know the code is not null.
  const roomCode = code;

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
  roomSettings = room.settings;
  showRoomInfo();
  element('player').textContent = session.profile.name;

  const roster = new Map<string, PublicPlayer>();
  let game: ReturnType<typeof createGame> | null = null;
  // The room state can arrive before the game is ready to show it.
  let pendingRoomState: RoomStateMsg | null = null;
  let attempts = 0;
  let linkReady = false;

  function connect(): void {
    const connection = new Connection(roomCode, session.token, {
      onWelcome(welcome) {
        attempts = 0;
        roster.clear();
        for (const other of welcome.players) roster.set(other.id, other);
        try {
          if (game) game.rejoin(welcome, connection);
          else game = createGame({ welcome, connection, roster, self: session.profile });
        } catch (error) {
          console.error(error);
          message.textContent =
            'Не удалось запустить игру. Проверьте, что в браузере включён WebGL.';
          return;
        }
        message.textContent = '';
        if (!linkReady) setupCopyLink();
        linkReady = true;
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
        roomSettings = state.settings;
        showRoomInfo();
        // The table also lists players who joined before this client did.
        for (const row of state.players) {
          if (row.online && row.id !== session.profile.id) roster.set(row.id, row);
        }
        pendingRoomState = state;
        game?.handleRoomState(state);
      },
      onClose(closeCode) {
        if (FINAL_CLOSE_CODES.has(closeCode) || attempts >= MAX_RECONNECT_ATTEMPTS) {
          game?.stop();
          message.textContent =
            CLOSE_MESSAGES[closeCode] ?? 'Соединение потеряно. Обновите страницу, чтобы вернуться.';
          return;
        }
        // The server keeps the player's place and score in the room for a while.
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempts, RECONNECT_MAX_DELAY_MS);
        attempts++;
        message.textContent = 'Соединение потеряно. Переподключение…';
        game?.pause('Соединение потеряно — переподключение…');
        window.setTimeout(connect, delay);
      },
    });
  }
  connect();
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
// How far above a teammate's head their label floats, in metres.
const TAG_GAP = 0.45;
// The player's own rocket is drawn from this far ahead of the eyes.
const ROCKET_SKIP = 1;
// How long a rail's trail stays in the air, in seconds.
const RAIL_TRAIL_S = 0.5;
const RAILGUN = WEAPONS.findIndex((spec) => spec.id === 'railgun');
const ROCKET_LAUNCHER = WEAPONS.findIndex((spec) => spec.kind === 'projectile');
// A rocket drawn at once waits this long for the server to number it.
const ROCKET_CONFIRM_MS = 1500;

/** The usable weapon after `state.current`, going `direction` (1 or -1) round the list. */
function nextWeapon(state: WeaponState, direction: number): number {
  for (let step = 1; step < WEAPONS.length; step++) {
    const index = (state.current + direction * step + WEAPONS.length * step) % WEAPONS.length;
    if (usable(state, index)) return index;
  }
  return state.current;
}

// After Esc releases the mouse, ignore Esc for a moment: that same key press must not
// close the menu it has just opened.
const ESCAPE_GUARD_MS = 250;

function createGame({ welcome, connection: firstConnection, roster, self }: GameOptions) {
  let connection = firstConnection;
  const canvas = element<HTMLCanvasElement>('view');
  const overlay = element('overlay');
  const hudRoot = element('hud');
  const play = element<HTMLButtonElement>('play');
  const slider = element<HTMLInputElement>('sensitivity');
  const sliderValue = element('sensitivity-value');

  const map = loadMap(welcome.map);
  const audio = new GameAudio();
  const renderer = createRenderer(canvas, map, (pos) => audio.debris(pos));
  window.addEventListener('resize', () => renderer.resize());
  const viewmodel = createViewmodel(element<HTMLCanvasElement>('viewmodel'));
  const hud = new Hud();

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
  const volumeValue = element('volume-value');
  volume.value = String(loadVolume());
  audio.setVolume(Number(volume.value));
  volumeValue.textContent = `${Math.round(Number(volume.value) * 100)} %`;
  volume.addEventListener('input', () => {
    audio.setVolume(Number(volume.value));
    volumeValue.textContent = `${Math.round(Number(volume.value) * 100)} %`;
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
  const hostMode = element<HTMLSelectElement>('host-mode');
  for (const mode of constants.room.modes) hostMode.add(new Option(modeName(mode), mode));
  const hostMap = element<HTMLSelectElement>('host-map');
  for (const name of availableMaps()) hostMap.add(new Option(mapName(name), name));
  hostMap.value = welcome.map;
  hostForm.addEventListener('submit', (event) => {
    event.preventDefault();
    connection.sendSettings(
      hostMode.value,
      hostMap.value,
      hostKillLimit.valueAsNumber,
      hostTimeLimit.valueAsNumber,
    );
  });

  const menu = new Menu(welcome.id, (team) => connection.sendTeam(team));

  const scoreboard = new Scoreboard(element('scoreboard'), welcome.id);
  let roomState: RoomStateMsg | null = null;
  let roomStateAt = 0;

  let running = true;
  let started = false;
  let unlockedAt = 0;
  // The pause menu was closed with Esc, but the browser has not given the mouse back yet.
  let dismissed = false;
  function refreshMenu(): void {
    const menu = !input.locked && !dismissed;
    overlay.hidden = !menu;
    hudRoot.hidden = menu;
    hud.setHint(
      dismissed && !input.locked ? 'Кликните или нажмите любую клавишу, чтобы продолжить' : '',
    );
  }
  const input: Input = new Input(
    canvas,
    () => sensitivity,
    (locked) => {
      dismissed = false;
      if (locked) {
        started = true;
        // From now on the menu is a pause menu.
        play.textContent = 'Продолжить';
        title.textContent = 'Пауза';
        paused = true;
        showRoomInfo();
      } else {
        unlockedAt = performance.now();
        chat.close();
      }
      refreshMenu();
    },
  );
  input.yaw = welcome.you.yaw;
  input.weapon = welcome.status.weapon;
  const chat = new Chat(
    (text) => connection.sendChat(text),
    (open) => input.suspend(open),
  );
  // Enter opens the chat field, Enter again sends the line. Esc cannot be used to cancel:
  // the browser takes it to release the mouse, which opens the menu and closes the chat.
  window.addEventListener('keydown', (event) => {
    if (chat.isOpen) {
      // Tab would move the focus out of the field.
      if (event.code === 'Tab') event.preventDefault();
      if (event.key !== 'Enter' || event.repeat || event.isComposing) return;
      event.preventDefault();
      chat.submit();
    } else if (event.key === 'Enter' && !event.repeat && running && input.locked) {
      event.preventDefault();
      chat.open();
    }
  });
  const lock = () => {
    if (!running) return;
    audio.resume();
    input.lock();
  };
  play.addEventListener('click', lock);
  canvas.addEventListener('click', lock);
  // Esc opens the pause menu (the browser releases the mouse); Esc again closes it.
  // Browsers do not count Esc as a gesture that may capture the mouse, so closing the
  // menu and getting the mouse back are separate steps: if the capture is refused, the
  // menu still closes and the next click or key press captures the mouse.
  window.addEventListener('keydown', (event) => {
    if (!started || !running || input.locked) return;
    if (event.code !== 'Escape') {
      if (dismissed) lock();
      return;
    }
    if (event.repeat || performance.now() - unlockedAt < ESCAPE_GUARD_MS) return;
    event.preventDefault();
    dismissed = !dismissed;
    refreshMenu();
    if (dismissed) lock();
  });

  const myId = welcome.id;
  let myTeam: Team | null = null;
  /**
   * How a player is shown. In a team mode the main colour is the team's and the
   * player's own colour becomes the accent (sleeves and details).
   */
  function appearance(id: string): NamedPlayer & { accent: string | null } {
    const player = id === myId ? { ...self, team: myTeam } : roster.get(id);
    if (!player) return { name: '?', color: '#ffffff', accent: null };
    return player.team
      ? { name: player.name, color: TEAM_COLORS[player.team], accent: player.color }
      : { name: player.name, color: player.color, accent: null };
  }
  const lookup = (id: string): NamedPlayer => appearance(id);

  const loop = new FixedStep(TICK_DT);
  const view = new ViewSmoother();
  let prediction = new Prediction(map, welcome.you, welcome.status);
  let remotes = new RemoteInterpolator(INTERPOLATION_DELAY_S);
  let status: SelfStatus = welcome.status;
  let others: (NamedPlayer & {
    accent: string | null;
    id: string;
    pos: Vec3;
    yaw: number;
    crouched: boolean;
    nameTag: boolean;
    dashing: boolean;
    quad: boolean;
  })[] = [];
  // Who killed the player, or a plain explanation when nobody did.
  let deathCause: NamedPlayer | string = '';
  let diedAt = 0;
  let stride = 0;
  let nextStep = STEP_DISTANCE;
  let weaponShown = welcome.status.weapon;
  // Rockets drawn at once, under temporary negative keys, until the server numbers them.
  let unconfirmed: { key: number; at: number }[] = [];
  let lastRocketKey = 0;
  const remoteSteps = new Map<string, { pos: Vec3; walked: number; dashing: boolean }>();

  function eyeOf(pos: Vec3, crouched: boolean): Vec3 {
    return [pos[0], pos[1] + (crouched ? PLAYER.crouchEyeHeight : PLAYER.standEyeHeight), pos[2]];
  }

  /** How far a rocket can fly from `origin` along `direction` before it meets the map. */
  function flight(origin: Vec3, direction: Vec3): number {
    const end = shotEnd(map, origin, direction, []);
    return Math.hypot(end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]);
  }

  function tracerStyle(weapon: number, shooter: string) {
    if (weapon !== RAILGUN) return undefined;
    return { color: appearance(shooter).color, life: RAIL_TRAIL_S, trail: true, power: 3 };
  }

  function fire(cmd: InputCmd): void {
    const weapon = prediction.weapon.current;
    const spec = WEAPONS[weapon];
    if (!spec) return;
    const origin = eyeOf(prediction.current.pos, prediction.current.crouched);
    // The tip of the barrel as drawn on screen, not the point between the eyes.
    const barrel = viewmodel.muzzle();
    const muzzle = renderer.screenToWorld(barrel.x, barrel.y, MUZZLE_DISTANCE);
    // Bullets and shells leave a spent case, thrown to the right.
    const cased = spec.kind === 'hitscan' && weapon !== RAILGUN;
    renderer.muzzleFlash(muzzle, weapon, cased ? [Math.cos(cmd.yaw), 0, -Math.sin(cmd.yaw)] : null);
    if (spec.kind === 'projectile') {
      const direction = aimDirection(cmd.yaw, cmd.pitch);
      const key = --lastRocketKey;
      unconfirmed.push({ key, at: performance.now() });
      renderer.launchRocket(key, origin, direction, flight(origin, direction), ROCKET_SKIP);
    } else {
      const style = tracerStyle(weapon, myId);
      for (const direction of pelletDirections(cmd.yaw, cmd.pitch, spec.pellets, spec.spread)) {
        renderer.addShot(muzzle, shotEnd(map, origin, direction, others), style);
      }
    }
    viewmodel.fire();
    hud.fired();
    audio.shot(null, weapon);
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

  /** Notices that the tick just simulated ended on a jump pad or went through a teleporter. */
  function triggers(): void {
    const now = prediction.current;
    const before = prediction.previous;
    const same = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    // A teleporter puts the player exactly on its exit.
    const gate = map.teleporters.find((g) => same(now.pos, g.to) && !same(before.pos, g.to));
    if (gate) {
      // Face the way out, and do not draw the camera flying across the map.
      input.yaw = gate.yaw;
      prediction.previous = now;
      view.reset();
      audio.teleport();
    } else if (
      map.pads.some((pad) => now.vel[1] === pad.velocity[1] && before.vel[1] !== pad.velocity[1])
    ) {
      audio.jumpPad();
    }
  }

  function remoteFootsteps(): void {
    for (const other of others) {
      const track = remoteSteps.get(other.id);
      if (!track) {
        remoteSteps.set(other.id, { pos: other.pos, walked: 0, dashing: other.dashing });
        continue;
      }
      if (other.dashing && !track.dashing) audio.dash(other.pos);
      track.dashing = other.dashing;
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

  /** The line at the top of the screen: the clock between two scores. */
  function showMatch(state: RoomStateMsg, timeLeft: number | null): void {
    const mine = state.players.find((row) => row.id === myId);
    let left: MatchSide | null = null;
    let right: MatchSide | null = null;
    if (state.teams) {
      const side = (team: Team): MatchSide => ({
        label: TEAM_NAMES[team],
        score: String(state.teams?.[team] ?? 0),
        color: TEAM_COLORS[team],
      });
      left = side('blue');
      right = side('red');
    } else if (state.state !== 'waiting') {
      // The table is ordered by place, so the first other player is the best rival.
      const rival = state.players.find((row) => row.id !== myId);
      left = { label: 'Вы', score: String(mine?.kills ?? 0), color: 'var(--accent)' };
      if (rival) {
        right = { label: rival.name, score: String(rival.kills), color: 'var(--ink-dim)' };
      }
    }
    if (state.state === 'waiting') hud.setMatch('Ожидание игроков', left, right);
    else if (state.state === 'results') hud.setMatch('Матч окончен', left, right);
    else hud.setMatch(formatClock(timeLeft ?? 0), left, right);

    const score = `${mine?.kills ?? 0} / ${mine?.deaths ?? 0}`;
    if (myTeam) hud.setPlayer(self.name, `${TEAM_NAMES[myTeam]} · ${score}`, TEAM_COLORS[myTeam]);
    else hud.setPlayer(self.name, score, 'var(--ink-dim)');
  }

  let lastTime = performance.now();
  let fps = 0;
  let lastYaw = input.yaw;
  let lastPitch = input.pitch;
  function frame(now: number): void {
    // A background tab can pause for seconds; do not replay that time.
    const dt = Math.min((now - lastTime) / 1000, 0.25);
    lastTime = now;
    const seconds = now / 1000;

    others = remotes.sample(seconds).map((remote) => ({
      ...remote,
      ...appearance(remote.id),
      // Teammates get a label on the HUD instead, visible through walls.
      nameTag: myTeam === null || roster.get(remote.id)?.team !== myTeam,
    }));
    const renderTime = remotes.renderTime(seconds);

    // The wheel goes round the weapons there is something to fire from. A weapon asked
    // for but not usable is forgotten, so that the wheel starts from the one in hand.
    const wheel = input.takeWheel();
    if (wheel !== 0) input.weapon = nextWeapon(prediction.weapon, Math.sign(wheel));
    else if (!usable(prediction.weapon, input.weapon)) input.weapon = prediction.weapon.current;

    const steps = running ? loop.advance(dt) : 0;
    for (let i = 0; i < steps; i++) {
      const cmd = input.command();
      const { seq, fired } = prediction.step(cmd);
      connection.sendInput(seq, cmd, renderTime);
      if (fired) fire(cmd);
      // The counter only goes up when a dash or a slide starts.
      if (prediction.current.dash > prediction.previous.dash) {
        hud.dashed();
        audio.dash(null);
      }
      footsteps();
      triggers();
    }
    remoteFootsteps();

    if (prediction.weapon.current !== weaponShown) {
      weaponShown = prediction.weapon.current;
      viewmodel.setWeapon(weaponShown);
      audio.weaponSwitch();
    }

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
    viewmodel.update(dt, stride, dead);

    hud.setHealth(status.hp);
    hud.setArmor(status.armor);
    hud.setWeapons(prediction.weapon);
    hud.setQuad(status.quad);
    hud.setDeath(
      dead ? deathCause : null,
      COMBAT.respawnDelayS - (now - diedAt) / 1000,
      COMBAT.respawnDelayS,
    );
    hud.setDash(dashReadiness(prediction.current));
    hud.setHeading(input.yaw);
    // The shortest way round, so that crossing ±π is not a full turn.
    const turned = Math.atan2(Math.sin(input.yaw - lastYaw), Math.cos(input.yaw - lastYaw));
    hud.sway(turned, input.pitch - lastPitch, dt);
    lastYaw = input.yaw;
    lastPitch = input.pitch;

    const mates: TeammateTag[] = [];
    const feet = prediction.current.pos;
    for (const other of others) {
      if (other.nameTag) continue;
      const [x, y, z] = other.pos;
      const height = other.crouched ? PLAYER.crouchHeight : PLAYER.standHeight;
      mates.push({
        id: other.id,
        name: other.name,
        color: other.color,
        pos: [x, y + height + TAG_GAP, z],
        distance: Math.hypot(x - feet[0], y - feet[1], z - feet[2]),
      });
    }
    hud.setTags(mates, renderer.worldToScreen);
    hud.updateWorld(renderer.worldToScreen);

    if (roomState) {
      const timeLeft =
        roomState.timeLeft === null ? null : roomState.timeLeft - (now - roomStateAt) / 1000;
      scoreboard.visible = roomState.state === 'results' || input.isDown('Tab');
      scoreboard.update(roomState, timeLeft);
      showMatch(roomState, timeLeft);
    }

    if (dt > 0) fps += (1 / dt - fps) * 0.05;
    const speed = Math.hypot(prediction.current.vel[0], prediction.current.vel[2]);
    const ping = connection.ping === null ? '—' : connection.ping.toFixed(0);
    hud.setDebug(`${ping} мс · ${fps.toFixed(0)} fps · ${speed.toFixed(1)} м/с`);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    handleSnapshot(snapshot: SnapshotMsg): void {
      // A weapon just picked up goes straight into the hands.
      const gained = snapshot.status.owned & ~status.owned;
      if (gained !== 0) input.weapon = 31 - Math.clz32(gained);
      status = snapshot.status;
      renderer.setItems(snapshot.items);
      remotes.push(snapshot.tick / SNAPSHOT_RATE, performance.now() / 1000, snapshot.players);
      view.nudge(prediction.reconcile(snapshot.you, snapshot.status, snapshot.ack));
    },
    handleRoomState(state: RoomStateMsg): void {
      if (state.settings.map !== map.name) {
        // The host has picked another map. The world, the prediction and the renderer
        // are all built around the map, so start afresh; the server keeps the seat.
        window.location.reload();
        return;
      }
      const previous = roomState;
      roomState = state;
      roomStateAt = performance.now();

      const isHost = state.hostId === myId;
      const editable = state.state !== 'match';
      menu.setHost(isHost);
      hostMode.disabled = hostMap.disabled = !editable;
      hostKillLimit.disabled = hostTimeLimit.disabled = hostApply.disabled = !editable;
      hostNote.textContent = editable
        ? 'Изменения действуют со следующего матча.'
        : 'Параметры можно менять между матчами.';
      // Do not overwrite what the host is typing with every periodic update.
      const changed =
        previous?.settings.mode !== state.settings.mode ||
        previous.settings.killLimit !== state.settings.killLimit ||
        previous.settings.timeLimitMin !== state.settings.timeLimitMin;
      if (changed) {
        hostMode.value = state.settings.mode;
        hostKillLimit.value = String(state.settings.killLimit);
        hostTimeLimit.value = String(state.settings.timeLimitMin);
      }

      myTeam = state.players.find((row) => row.id === myId)?.team ?? null;
      menu.update(state);
    },
    handleEvent(event: EventMsg): void {
      switch (event.e) {
        case 'shot': {
          const from: Vec3 = [event.from[0], event.from[1] - 0.14, event.from[2]];
          const style = tracerStyle(event.w, event.id);
          for (const to of event.to) renderer.addShot(from, to, style);
          renderer.muzzleFlash(event.from, event.w, null);
          audio.shot(event.from, event.w);
          break;
        }
        case 'rocket': {
          if (event.id === myId) {
            const now = performance.now();
            unconfirmed = unconfirmed.filter((rocket) => now - rocket.at < ROCKET_CONFIRM_MS);
            const drawn = unconfirmed.shift();
            if (drawn) {
              renderer.bindRocket(drawn.key, event.n);
              break;
            }
          } else {
            audio.shot(event.from, ROCKET_LAUNCHER);
            renderer.muzzleFlash(event.from, ROCKET_LAUNCHER, null);
          }
          renderer.launchRocket(event.n, event.from, event.dir, flight(event.from, event.dir));
          break;
        }
        case 'explode':
          renderer.explode(event.n, event.pos);
          audio.explosion(event.pos);
          break;
        case 'pickup': {
          const item = map.items[event.item];
          if (!item) break;
          if (event.id === myId) hud.pickup(itemLabel(item.type));
          audio.pickup(event.id === myId ? null : item.position, itemKind(item.type));
          break;
        }
        case 'hit':
          // A player's own rocket can hurt them too; that is not a hit to celebrate.
          if (event.by === myId && event.target !== myId) {
            hud.hitMarker(event.head);
            audio.hitConfirm(event.head);
            const target = others.find((other) => other.id === event.target);
            if (target) {
              const height = target.crouched ? PLAYER.crouchHeight : PLAYER.standHeight;
              const [x, y, z] = target.pos;
              // Over the head for a headshot, at the chest otherwise.
              hud.damageNumber(
                [x, y + height * (event.head ? 1.05 : 0.7), z],
                event.dmg,
                event.head,
              );
            }
          }
          if (event.target === myId) {
            const [x, , z] = prediction.current.pos;
            // Yaw of the direction to the attacker, relative to where the player looks.
            const toAttacker = Math.atan2(x - event.from[0], z - event.from[2]);
            hud.damageFrom(input.yaw - toAttacker);
            audio.hurt();
          }
          break;
        case 'kill': {
          const fallen =
            event.target === myId
              ? prediction.current.pos
              : others.find((other) => other.id === event.target)?.pos;
          // Nobody sees what becomes of those who fall off the map.
          if (fallen && !event.fall) renderer.gore(fallen);
          if (event.by === event.target) {
            const how = event.fall ? 'сорвался с карты' : 'подорвался на своей ракете';
            hud.addNotice(lookup(event.target), how);
            if (event.target === myId) {
              deathCause = event.fall ? 'Вы сорвались с карты' : 'Вы подорвались на своей ракете';
              diedAt = performance.now();
            }
            audio.death(others.find((other) => other.id === event.target)?.pos ?? null);
            break;
          }
          hud.addKill(
            lookup(event.by),
            lookup(event.target),
            event.head,
            event.by === myId || event.target === myId,
          );
          if (event.target === myId) {
            deathCause = lookup(event.by);
            diedAt = performance.now();
            audio.death(null);
          } else {
            const victim = others.find((other) => other.id === event.target);
            audio.death(victim?.pos ?? null);
            if (event.by === myId) hud.hitMarker(true);
          }
          break;
        }
        case 'team': {
          // The roster still holds the old side; show the new one.
          const player = appearance(event.id);
          hud.addNotice(
            { name: player.name, color: TEAM_COLORS[event.team] },
            event.team === 'blue' ? 'теперь за синих' : 'теперь за красных',
          );
          if (event.id === myId) {
            deathCause = 'Вы сменили команду';
            diedAt = performance.now();
          }
          break;
        }
        case 'chat':
          chat.add(lookup(event.id), event.text);
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
    /** Holds the game still while the connection is being restored. */
    pause(reason: string): void {
      running = false;
      chat.close();
      hud.setNetworkStatus(reason);
    },
    /** Continues on a new connection: the server has put the player back into the room. */
    rejoin(again: WelcomeMsg, newConnection: Connection): void {
      if (again.map !== map.name) {
        window.location.reload();
        return;
      }
      connection = newConnection;
      prediction = new Prediction(map, again.you, again.status);
      remotes = new RemoteInterpolator(INTERPOLATION_DELAY_S);
      status = again.status;
      input.weapon = again.status.weapon;
      unconfirmed = [];
      input.yaw = again.you.yaw;
      input.pitch = 0;
      view.reset();
      hud.setNetworkStatus('');
      running = true;
    },
    /** Freezes the game for good; the last frame stays on screen. */
    stop(): void {
      running = false;
      chat.close();
      dismissed = false;
      refreshMenu();
      play.hidden = true;
      title.textContent = roomLabel;
      paused = false;
      showRoomInfo();
      hud.setNetworkStatus('');
      if (document.pointerLockElement) document.exitPointerLock();
    },
  };
}
