import type { RoomStateMsg, ScoreRow } from './net/protocol';

const COLUMNS = ['Игрок', 'Убийства', 'Смерти', 'K/D', 'Пинг'];

/** Kills per death; a player who has not died yet counts as having died once. */
export function killDeathRatio(kills: number, deaths: number): string {
  return (kills / Math.max(deaths, 1)).toFixed(2);
}

/** "M:SS" for a number of seconds, rounded up so the clock hits 0:00 exactly at the end. */
export function formatClock(seconds: number): string {
  const whole = Math.max(Math.ceil(seconds), 0);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Headline of the results screen. Rows must be ordered from first place to last. */
export function resultTitle(rows: readonly ScoreRow[]): { text: string; winner: ScoreRow | null } {
  const [first, second] = rows;
  if (!first || (second && second.kills === first.kills && second.deaths === first.deaths)) {
    return { text: 'Матч окончен — ничья', winner: null };
  }
  return { text: 'Матч окончен — победил ', winner: first };
}

/** The score table shown while Tab is held and after a match. Names are set as text. */
export class Scoreboard {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly myId: string,
  ) {
    this.root = root;
    this.title = document.createElement('p');
    this.title.className = 'scoreboard-title';
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const column of COLUMNS) {
      const cell = document.createElement('th');
      cell.textContent = column;
      head.append(cell);
    }
    this.body = table.createTBody();
    root.replaceChildren(this.title, table);
  }

  set visible(visible: boolean) {
    this.root.hidden = !visible;
  }

  update(state: RoomStateMsg, timeLeft: number | null): void {
    this.title.textContent = '';
    if (state.state === 'results') {
      const { text, winner } = resultTitle(state.players);
      this.title.append(text);
      if (winner) {
        const name = document.createElement('span');
        name.textContent = winner.name;
        name.style.color = winner.color;
        this.title.append(name);
      }
      if (timeLeft !== null) this.title.append(` · новый матч через ${Math.ceil(timeLeft)}`);
    } else if (state.state === 'waiting') {
      this.title.textContent = 'Ожидание игроков — счёт пока не идёт';
    } else {
      this.title.textContent = `До ${state.settings.killLimit} убийств`;
    }

    this.body.replaceChildren(
      ...state.players.map((player) => {
        const row = document.createElement('tr');
        row.classList.toggle('me', player.id === this.myId);
        row.classList.toggle('offline', !player.online);
        const name = row.insertCell();
        name.textContent = player.name;
        name.style.color = player.color;
        row.insertCell().textContent = String(player.kills);
        row.insertCell().textContent = String(player.deaths);
        row.insertCell().textContent = killDeathRatio(player.kills, player.deaths);
        row.insertCell().textContent = player.online ? String(player.ping) : 'вышел';
        return row;
      }),
    );
  }
}
