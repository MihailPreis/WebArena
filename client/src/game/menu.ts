import { TEAM_COLORS, TEAM_NAMES, TEAMS, type Team } from '../shared/roomText';
import type { RoomStateMsg, ScoreRow } from './net/protocol';

type Tab = 'game' | 'settings' | 'host';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} element is missing`);
  return found as T;
}

function line(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/**
 * Whether a player may move to `team`: the server refuses a switch that leaves the
 * sides uneven by more than one. `sizes` counts the players who are online.
 */
export function canSwitch(sizes: Record<Team, number>, from: Team, to: Team): boolean {
  return from !== to && sizes[to] + 1 - (sizes[from] - 1) <= 1;
}

/** The room menu: tabs, the squads or the list of players, and the player's own numbers. */
export class Menu {
  private readonly tabs = [...element('tabs').querySelectorAll<HTMLButtonElement>('button')];
  private readonly panels = [...document.querySelectorAll<HTMLElement>('#menu [data-panel]')];
  private readonly teamPicker = element('team-picker');
  private readonly teamNote = element('team-note');
  private readonly squads = new Map<Team, HTMLButtonElement>();
  private readonly roster = element('roster');
  private readonly rosterNote = element('roster-note');
  private readonly rosterList = element('roster-list');
  private readonly kills = element('me-kills');
  private readonly deaths = element('me-deaths');
  private readonly ping = element('me-ping');
  private current: Tab = 'game';

  constructor(
    private readonly myId: string,
    onTeam: (team: Team) => void,
  ) {
    for (const tab of this.tabs) {
      tab.addEventListener('click', () => this.show(tab.dataset.tab as Tab));
    }
    for (const button of this.teamPicker.querySelectorAll<HTMLButtonElement>('button')) {
      const team = button.dataset.team as Team;
      this.squads.set(team, button);
      button.style.setProperty('--team', TEAM_COLORS[team]);
      button.addEventListener('click', () => onTeam(team));
    }
    element('tabs').hidden = false;
    element('menu').hidden = false;
    this.show('game');
  }

  private show(tab: Tab): void {
    this.current = tab;
    for (const button of this.tabs) {
      button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    }
    for (const panel of this.panels) panel.hidden = panel.dataset.panel !== tab;
  }

  /** Only the host sees the tab with the rules of the match. */
  setHost(isHost: boolean): void {
    const tab = this.tabs.find((button) => button.dataset.tab === 'host');
    if (tab) tab.hidden = !isHost;
    if (!isHost && this.current === 'host') this.show('game');
  }

  update(state: RoomStateMsg): void {
    const me = state.players.find((row) => row.id === this.myId);
    this.kills.textContent = String(me?.kills ?? 0);
    this.deaths.textContent = String(me?.deaths ?? 0);
    this.ping.textContent = me ? String(me.ping) : '—';

    const myTeam = me?.team ?? null;
    const teams = state.teams !== null && myTeam !== null;
    this.teamPicker.hidden = !teams;
    this.roster.hidden = teams;
    if (state.teams && myTeam) this.updateSquads(state, state.teams, myTeam);
    else this.updateRoster(state);
  }

  private updateSquads(state: RoomStateMsg, scores: Record<Team, number>, myTeam: Team): void {
    const online = state.players.filter((row) => row.online);
    const sizes = { blue: 0, red: 0 };
    for (const row of online) if (row.team) sizes[row.team]++;

    for (const team of TEAMS) {
      const button = this.squads.get(team);
      if (!button) continue;
      const mine = team === myTeam;
      const open = canSwitch(sizes, myTeam, team);

      const head = line('squad-head', '');
      head.append(line('', TEAM_NAMES[team]), line('squad-score', String(scores[team])));
      const rows = online
        .filter((row) => row.team === team)
        .map((row) => line('squad-row', row.id === this.myId ? `${row.name} — вы` : row.name));
      if (rows.length === 0) rows.push(line('squad-row empty', 'пока никого'));
      const badge = mine ? 'Ваш отряд' : open ? 'Перейти' : 'Отряды должны быть равны';
      button.replaceChildren(head, ...rows, line('squad-badge', badge));
      button.setAttribute('aria-pressed', String(mine));
      button.disabled = !open;
    }
    this.teamNote.textContent =
      state.state === 'match'
        ? 'Смена в бою считается смертью'
        : 'До начала матча отряд можно менять свободно';
  }

  private updateRoster(state: RoomStateMsg): void {
    this.rosterNote.textContent =
      state.state === 'waiting' ? 'Ожидание игроков — счёт пока не идёт' : 'убийства / смерти';
    this.rosterList.replaceChildren(
      ...state.players.map((row: ScoreRow) => {
        const item = document.createElement('li');
        item.classList.toggle('me', row.id === this.myId);
        item.classList.toggle('offline', !row.online);
        const name = line('name', row.name);
        name.style.setProperty('--c', row.color);
        item.append(name, line('', `${row.kills} / ${row.deaths}`));
        return item;
      }),
    );
  }
}
