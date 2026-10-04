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

/** "Синие 12 : 9 Красные" */
export function teamScoreLine(scores: Record<Team, number>): string {
  return `${TEAM_NAMES.blue} ${scores.blue} : ${scores.red} ${TEAM_NAMES.red}`;
}

function coloured(text: string, color: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.textContent = text;
  span.style.color = color;
  return span;
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
        const cell = header.insertCell();
        cell.colSpan = COLUMNS.length;
        cell.textContent = `${TEAM_NAMES[team]} — ${state.teams[team]}`;
        cell.style.color = TEAM_COLORS[team];
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
    this.title.textContent = '';
    if (state.state === 'results') {
      if (state.teams) {
        const winner = winningTeam(state.teams);
        if (winner) {
          const name = TEAM_NAMES[winner].toLowerCase();
          this.title.append('Матч окончен — победили ', coloured(name, TEAM_COLORS[winner]));
        } else {
          this.title.append('Матч окончен — ничья');
        }
      } else {
        const { text, winner } = resultTitle(state.players);
        this.title.append(text);
        if (winner) this.title.append(coloured(winner.name, winner.color));
      }
      if (timeLeft !== null) this.title.append(` · новый матч через ${Math.ceil(timeLeft)}`);
    } else if (state.state === 'waiting') {
      this.title.textContent = 'Ожидание игроков — счёт пока не идёт';
    } else if (state.teams) {
      this.title.textContent = `${teamScoreLine(state.teams)} · до ${state.settings.killLimit}`;
    } else {
      this.title.textContent = `До ${state.settings.killLimit} убийств`;
    }
  }

  private playerRow(player: ScoreRow): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.classList.toggle('me', player.id === this.myId);
    row.classList.toggle('offline', !player.online);
    const name = row.insertCell();
    if (player.team) {
      // The name takes the team's colour; the dot keeps the player's own.
      const dot = coloured('■ ', player.color);
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
