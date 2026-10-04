import '../style.css';
import './game.css';
import arenaJson from '@shared/maps/arena.json';
import { ApiError, getRoom, isRoomFull, type RoomInfo } from '../shared/api';
import { roomCodeFromPath } from '../shared/roomCode';
import { describeSettings } from '../shared/roomText';
import { ensureSession, type Session } from '../shared/session';
import { Input } from './input';
import { createRenderer } from './render/renderer';
import { loadSensitivity, saveSensitivity, SENSITIVITY_MAX, SENSITIVITY_MIN } from './settings';
import { TICK_DT } from './sim/constants';
import { FixedStep } from './sim/fixedStep';
import { parseMap } from './sim/map';
import { createPlayer, stepPlayer, type PlayerState } from './sim/movement';
import { ViewSmoother } from './view';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} element is missing`);
  return found as T;
}

const title = element('room-title');
const message = element('message');

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

  message.textContent = '';
  element('room-info').textContent = describeSettings(room.settings);
  const player = element('player');
  player.textContent = session.profile.name;
  player.style.color = session.profile.color;
  setupCopyLink();

  try {
    start();
  } catch (error) {
    console.error(error);
    message.textContent = 'Не удалось запустить игру. Проверьте, что в браузере включён WebGL.';
  }
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

function start(): void {
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

  const input = new Input(
    canvas,
    () => sensitivity,
    (locked) => {
      overlay.hidden = locked;
      hud.hidden = !locked;
    },
  );
  play.addEventListener('click', () => input.lock());
  canvas.addEventListener('click', () => input.lock());
  for (const id of ['play', 'controls', 'sensitivity-row']) element(id).hidden = false;

  const loop = new FixedStep(TICK_DT);
  const view = new ViewSmoother();
  let spawnIndex = Math.floor(Math.random() * map.spawns.length);
  let current: PlayerState;
  let previous: PlayerState;

  function respawn(): void {
    const spawn = map.spawns[spawnIndex % map.spawns.length];
    if (!spawn) throw new Error('map has no spawns');
    spawnIndex++;
    current = createPlayer(spawn);
    previous = current;
    input.yaw = spawn.yaw;
    input.pitch = 0;
    view.reset();
  }
  respawn();

  let lastTime = performance.now();
  let fps = 0;
  function frame(now: number): void {
    // A background tab can pause for seconds; do not replay that time.
    const dt = Math.min((now - lastTime) / 1000, 0.25);
    lastTime = now;

    const steps = loop.advance(dt);
    for (let i = 0; i < steps; i++) {
      previous = current;
      current = stepPlayer(current, input.command(), map, TICK_DT);
      if (current.pos[1] < map.killY) respawn();
    }

    renderer.render(view.update(previous, current, loop.alpha, input.yaw, input.pitch, dt));

    if (dt > 0) fps += (1 / dt - fps) * 0.05;
    const speed = Math.hypot(current.vel[0], current.vel[2]);
    debug.textContent = `${fps.toFixed(0)} fps\n${speed.toFixed(1)} м/с`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
