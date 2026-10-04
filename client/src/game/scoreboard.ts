import { TEAM_COLORS, TEAM_NAMES, TEAMS } from '../shared/roomText';
import type { RoomStateMsg, ScoreRow, Team } from './net/protocol';

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

/** The team with the higher score, or null when the scores are level. */
export function winningTeam(scores: Record<Team, number>): Team | null {
  if (scores.blue === scores.red) return null;
  return scores.blue > scores.red ? 'blue' : 'red';
}

/** How the match ended for one player. */
export type Outcome = 'win' | 'loss' | 'draw';

/** The result of a finished match from the point of view of the player `myId`. */
export function outcomeFor(state: RoomStateMsg, myId: string): Outcome {
  if (state.teams) {
    const winner = winningTeam(state.teams);
    if (!winner) return 'draw';
    return state.players.find((row) => row.id === myId)?.team === winner ? 'win' : 'loss';
  }
  const { winner } = resultTitle(state.players);
  if (!winner) return 'draw';
  return winner.id === myId ? 'win' : 'loss';
}

/** "Синие 12 : 9 Красные" */
export function teamScoreLine(scores: Record<Team, number>): string {
  return `${TEAM_NAMES.blue} ${scores.blue} : ${scores.red} ${TEAM_NAMES.red}`;
}

function coloured(text: string, color: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'name';
  span.textContent = text;
  span.style.setProperty('--c', color);
  return span;
}

const OUTCOME_TITLES: Record<Outcome, string> = {
  win: 'Победа',
  loss: 'Поражение',
  draw: 'Ничья',
};

/** The score table shown while Tab is held and after a match. Names are set as text. */
export class Scoreboard {
  private readonly root: HTMLElement;
  private readonly eyebrow: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly myId: string,
  ) {
    this.root = root;
    this.eyebrow = document.createElement('p');
    this.eyebrow.className = 'eyebrow';
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
    root.replaceChildren(this.eyebrow, this.title, table);
  }

  set visible(visible: boolean) {
    this.root.hidden = !visible;
  }

  update(state: RoomStateMsg, timeLeft: number | null): void {
    this.updateTitle(state, timeLeft);

    const rows: HTMLTableRowElement[] = [];
    if (state.teams) {
      // Players arrive ordered by team, the leading team first.
      const order = TEAMS.filter((team) => state.players.some((p) => p.team === team));
      order.sort(
        (a, b) =>
          state.players.findIndex((p) => p.team === a) -
          state.players.findIndex((p) => p.team === b),
      );
      for (const team of order) {
        const header = document.createElement('tr');
        header.className = 'team';
        header.style.setProperty('--c', TEAM_COLORS[team]);
        const cell = header.insertCell();
        cell.colSpan = COLUMNS.length;
        cell.textContent = `${TEAM_NAMES[team]} · ${state.teams[team]}`;
        rows.push(header);
        for (const player of state.players) {
          if (player.team === team) rows.push(this.playerRow(player));
        }
      }
    } else {
      for (const player of state.players) rows.push(this.playerRow(player));
    }
    this.body.replaceChildren(...rows);
  }

  private updateTitle(state: RoomStateMsg, timeLeft: number | null): void {
    const limit = `до ${state.settings.killLimit} убийств`;
    this.root.dataset.outcome = '';
    this.title.textContent = '';
    if (state.state === 'results') {
      const outcome = outcomeFor(state, this.myId);
      this.root.dataset.outcome = outcome;
      const next = timeLeft === null ? '' : ` · новый матч через ${Math.ceil(timeLeft)}`;
      const { winner } = resultTitle(state.players);
      if (state.teams) {
        this.eyebrow.textContent = `Матч окончен · ${teamScoreLine(state.teams)}${next}`;
        this.title.textContent = OUTCOME_TITLES[outcome];
      } else if (outcome === 'loss' && winner) {
        this.eyebrow.textContent = `Матч окончен${next}`;
        this.title.append('Победил ', coloured(winner.name, winner.color));
      } else {
        this.eyebrow.textContent = `Матч окончен${next}`;
        this.title.textContent = OUTCOME_TITLES[outcome];
      }
    } else if (state.state === 'waiting') {
      this.eyebrow.textContent = 'Счёт пока не идёт';
      this.title.textContent = 'Ожидание игроков';
    } else if (state.teams) {
      this.eyebrow.textContent = `Team Deathmatch · ${limit}`;
      this.title.textContent = teamScoreLine(state.teams);
    } else {
      this.eyebrow.textContent = `Deathmatch · ${limit}`;
      this.title.textContent = timeLeft === null ? 'Таблица' : formatClock(timeLeft);
    }
  }

  private playerRow(player: ScoreRow): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.classList.toggle('me', player.id === this.myId);
    row.classList.toggle('offline', !player.online);
    const name = row.insertCell();
    if (player.team) {
      // The name takes the team's colour; the square keeps the player's own.
      const dot = document.createElement('i');
      dot.className = 'dot';
      dot.style.background = player.color;
      name.append(dot, coloured(player.name, TEAM_COLORS[player.team]));
    } else {
      name.append(coloured(player.name, player.color));
    }
    row.insertCell().textContent = String(player.kills);
    row.insertCell().textContent = String(player.deaths);
    row.insertCell().textContent = killDeathRatio(player.kills, player.deaths);
    row.insertCell().textContent = player.online ? String(player.ping) : 'вышел';
    return row;
  }
}
