import '../style.css';
import './home.css';
import constants from '@shared/constants.json';
import {
  ApiError,
  createRoom,
  getLeaderboard,
  getPlayerStats,
  getRoom,
  isRoomFull,
  updateMe,
  type LeaderboardKind,
  type Profile,
} from '../shared/api';
import { isRoomCode } from '../shared/roomCode';
import { modeName } from '../shared/roomText';
import { ensureSession, type Session } from '../shared/session';

const { profile: PROFILE, room: ROOM } = constants;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} element is missing`);
  return found as T;
}

const status = element('status');
const nameInput = element<HTMLInputElement>('name');
const colors = element('colors');
const profileMessage = element('profile-message');
const createForm = element<HTMLFormElement>('create-form');
const createButton = element<HTMLButtonElement>('create');
const createMessage = element('create-message');
const joinForm = element<HTMLFormElement>('join-form');
const joinButton = element<HTMLButtonElement>('join');
const joinMessage = element('join-message');
const codeInput = element<HTMLInputElement>('code');

const SERVER_DOWN = 'Сервер недоступен. Попробуйте обновить страницу.';

function setupLimit(id: string, limit: { min: number; max: number; default: number }) {
  const input = element<HTMLInputElement>(id);
  input.min = String(limit.min);
  input.max = String(limit.max);
  input.value = String(limit.default);
  return input;
}

const modeSelect = element<HTMLSelectElement>('mode');
for (const mode of ROOM.modes) modeSelect.add(new Option(modeName(mode), mode));
const killLimit = setupLimit('kill-limit', ROOM.killLimit);
const timeLimit = setupLimit('time-limit', ROOM.timeLimitMin);
const maxPlayers = setupLimit('max-players', ROOM.maxPlayers);
nameInput.maxLength = PROFILE.nameMaxLength;

function setupProfile(session: Session): void {
  let profile = session.profile;

  const customColor = document.createElement('input');
  customColor.type = 'color';
  customColor.id = 'custom-color';
  customColor.title = 'Свой цвет';
  customColor.setAttribute('aria-label', 'Свой цвет');

  const swatches = PROFILE.colors.map((color) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    swatch.style.background = color;
    swatch.setAttribute('aria-label', `Цвет ${color}`);
    swatch.addEventListener('click', () => void save({ color }));
    colors.append(swatch);
    return { color, swatch };
  });
  colors.append(customColor);

  function show(next: Profile): void {
    profile = next;
    nameInput.value = next.name;
    nameInput.style.color = next.color;
    customColor.value = next.color;
    for (const { color, swatch } of swatches) {
      swatch.setAttribute('aria-pressed', String(color === next.color));
    }
  }

  async function save(update: { name?: string; color?: string }): Promise<void> {
    profileMessage.className = 'message';
    try {
      show(await updateMe(session.token, update));
      profileMessage.textContent = 'Сохранено';
      profileMessage.classList.add('ok');
    } catch (error) {
      show(profile);
      if (error instanceof ApiError && error.status === 422) {
        profileMessage.textContent =
          update.color !== undefined
            ? 'Цвет слишком тёмный — выберите светлее.'
            : `Имя: от 1 до ${PROFILE.nameMaxLength} символов.`;
      } else {
        profileMessage.textContent = SERVER_DOWN;
      }
    }
  }

  nameInput.addEventListener('change', () => {
    const name = nameInput.value.trim();
    if (name === profile.name) show(profile);
    else void save({ name });
  });
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') nameInput.blur();
  });
  customColor.addEventListener('change', () => void save({ color: customColor.value }));

  show(profile);
  nameInput.disabled = false;
}

function setupRooms(session: Session): void {
  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    createMessage.textContent = '';
    createButton.disabled = true;
    createRoom(session.token, {
      mode: modeSelect.value,
      killLimit: killLimit.valueAsNumber,
      timeLimitMin: timeLimit.valueAsNumber,
      maxPlayers: maxPlayers.valueAsNumber,
    })
      .then((room) => window.location.assign(`/game/${room.code}`))
      .catch((error: unknown) => {
        createButton.disabled = false;
        createMessage.textContent =
          error instanceof ApiError && error.status === 422
            ? 'Проверьте параметры матча.'
            : SERVER_DOWN;
      });
  });

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = codeInput.value.trim().toUpperCase();
    if (!isRoomCode(code)) {
      joinMessage.textContent = 'Код комнаты — 4 символа: латинские буквы и цифры.';
      return;
    }
    joinMessage.textContent = '';
    joinButton.disabled = true;
    getRoom(code)
      .then((room) => {
        if (isRoomFull(room)) throw new ApiError(409);
        window.location.assign(`/game/${room.code}`);
      })
      .catch((error: unknown) => {
        joinButton.disabled = false;
        const failure = error instanceof ApiError ? error.status : 0;
        if (failure === 404) joinMessage.textContent = 'Комната не найдена.';
        else if (failure === 409) joinMessage.textContent = 'Комната заполнена.';
        else joinMessage.textContent = SERVER_DOWN;
      });
  });

  createButton.disabled = false;
  joinButton.disabled = false;
}

// Which column each ranking is sorted by, counting from the left.
const SORTED_COLUMN: Record<LeaderboardKind, number> = { kd: 5, kills: 3, wins: 6 };

function setupLeaderboard(myId: string | null): void {
  const body = element('leaderboard-body');
  const note = element('leaderboard-note');
  const tabs = [...element('leaderboard-tabs').querySelectorAll<HTMLButtonElement>('button')];

  async function show(by: LeaderboardKind): Promise<void> {
    for (const tab of tabs) tab.setAttribute('aria-pressed', String(tab.dataset.by === by));
    try {
      const board = await getLeaderboard(by);
      body.replaceChildren(
        ...board.players.map((player, index) => {
          const row = document.createElement('tr');
          row.classList.toggle('me', player.id === myId);
          const cells = [
            index + 1,
            player.name,
            player.matches,
            player.kills,
            player.deaths,
            player.kd.toFixed(2),
            player.wins,
          ];
          cells.forEach((value, column) => {
            const cell = row.insertCell();
            cell.textContent = String(value);
            if (column === 1) cell.style.color = player.color;
            cell.classList.toggle('sorted', column === SORTED_COLUMN[by]);
          });
          return row;
        }),
      );
      if (board.players.length === 0) {
        note.textContent =
          by === 'kd'
            ? `Пока никто не набрал ${board.minKills} убийств — столько нужно для рейтинга по K/D.`
            : 'Пока никто не сыграл ни одного матча.';
      } else {
        note.textContent =
          by === 'kd' ? `В рейтинге по K/D — игроки от ${board.minKills} убийств.` : '';
      }
    } catch {
      body.replaceChildren();
      note.textContent = SERVER_DOWN;
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => void show(tab.dataset.by as LeaderboardKind));
  }
  void show('kd');
}

async function showMyStats(session: Session): Promise<void> {
  const stats = await getPlayerStats(session.profile.id);
  element('my-stats').textContent =
    stats.matches === 0
      ? 'Вы ещё не сыграли ни одного матча.'
      : [
          `Вы: матчей ${stats.matches}`,
          `побед ${stats.wins}`,
          `убийств ${stats.kills}`,
          `смертей ${stats.deaths}`,
          `K/D ${stats.kd.toFixed(2)}`,
          `точность ${Math.round(stats.accuracy * 100)} %`,
        ].join(' · ');
}

ensureSession()
  .then((session) => {
    setupProfile(session);
    setupRooms(session);
    setupLeaderboard(session.profile.id);
    showMyStats(session).catch(() => undefined);
  })
  .catch((error: unknown) => {
    console.error(error);
    status.textContent = SERVER_DOWN;
    setupLeaderboard(null);
  });
