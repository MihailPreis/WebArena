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
  type LeaderboardKind,
} from '../shared/api';
import { setupProfileEditor } from '../shared/profileEditor';
import { isRoomCode } from '../shared/roomCode';
import { availableMaps, mapName, modeName } from '../shared/roomText';
import { ensureSession, type Session } from '../shared/session';

const { room: ROOM } = constants;

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
const TOO_MANY_REQUESTS = 'Слишком много запросов. Подождите минуту и попробуйте снова.';

function setupLimit(id: string, limit: { min: number; max: number; default: number }) {
  const input = element<HTMLInputElement>(id);
  input.min = String(limit.min);
  input.max = String(limit.max);
  input.value = String(limit.default);
  return input;
}

const modeSelect = element<HTMLSelectElement>('mode');
for (const mode of ROOM.modes) modeSelect.add(new Option(modeName(mode), mode));
const mapSelect = element<HTMLSelectElement>('map');
for (const map of availableMaps()) mapSelect.add(new Option(mapName(map), map));
const killLimit = setupLimit('kill-limit', ROOM.killLimit);
const timeLimit = setupLimit('time-limit', ROOM.timeLimitMin);
const maxPlayers = setupLimit('max-players', ROOM.maxPlayers);

function setupProfile(session: Session): void {
  setupProfileEditor({
    session,
    nameInput,
    colors,
    message: profileMessage,
    serverDown: SERVER_DOWN,
  });
}

function setupRooms(session: Session): void {
  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    createMessage.textContent = '';
    createButton.disabled = true;
    createRoom(session.token, {
      mode: modeSelect.value,
      map: mapSelect.value,
      killLimit: killLimit.valueAsNumber,
      timeLimitMin: timeLimit.valueAsNumber,
      maxPlayers: maxPlayers.valueAsNumber,
    })
      .then((room) => window.location.assign(`/game/${room.code}`))
      .catch((error: unknown) => {
        createButton.disabled = false;
        const failure = error instanceof ApiError ? error.status : 0;
        if (failure === 422) createMessage.textContent = 'Проверьте параметры матча.';
        else if (failure === 429) createMessage.textContent = TOO_MANY_REQUESTS;
        else createMessage.textContent = SERVER_DOWN;
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
            ? `Пока никто не набрал ${board.minKills} убийств — столько нужно для рейтинга по K/\u2060D.`
            : 'Пока никто не сыграл ни одного матча.';
      } else {
        note.textContent =
          by === 'kd' ? `В рейтинге по K/\u2060D — игроки от ${board.minKills} убийств.` : '';
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
  element('my-stats').hidden = false;
  const note = element('my-stats-note');
  const list = element('my-stats-list');
  if (stats.matches === 0) {
    note.textContent = 'Вы ещё не сыграли ни одного матча.';
    list.hidden = true;
    return;
  }
  note.textContent = '';
  const tiles: [string, string][] = [
    [String(stats.matches), 'матчей'],
    [String(stats.wins), 'побед'],
    [String(stats.kills), 'убийств'],
    [String(stats.deaths), 'смертей'],
    [stats.kd.toFixed(2), 'K/D'],
    [`${Math.round(stats.accuracy * 100)} %`, 'точность'],
  ];
  list.replaceChildren(
    ...tiles.map(([value, label]) => {
      const tile = document.createElement('div');
      const number = document.createElement('dd');
      number.textContent = value;
      const caption = document.createElement('dt');
      caption.textContent = label;
      tile.append(number, caption);
      return tile;
    }),
  );
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
    status.textContent =
      error instanceof ApiError && error.status === 429 ? TOO_MANY_REQUESTS : SERVER_DOWN;
    setupLeaderboard(null);
  });
