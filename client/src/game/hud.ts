import { heading, headingText, MARK_STEP, markLabel } from './compass';
import type { Vec3 } from './sim/map';

const KILL_FEED_SIZE = 5;
const KILL_FEED_TTL_MS = 6000;
const HIT_MARKER_MS = 160;
const DAMAGE_INDICATOR_MS = 1000;
const DAMAGE_NUMBER_MS = 800;
const LOW_HEALTH = 30;

// The compass strip: width of one degree, in em, and how many turns are laid out.
const EM_PER_DEGREE = 0.225;
const STRIP_DEGREES = 720;

// The cards trail behind the camera: pixels of offset per radian per second of turning.
const SWAY_PER_RAD_S = 4;
const SWAY_MAX_PX = 14;
const SWAY_RATE = 10;

const WEAPON_GLYPH =
  '<svg class="glyph" viewBox="0 0 34 12" aria-hidden="true"><path d="M1 5h24M25 5l8-3M8 5v6M17 5v4"/></svg>';

export interface NamedPlayer {
  name: string;
  color: string;
}

/** One side of the score line at the top of the screen. */
export interface MatchSide {
  label: string;
  score: string;
  color: string;
}

/** A label over a teammate. */
export interface TeammateTag {
  id: string;
  name: string;
  color: string;
  /** Where the label is anchored in the world. */
  pos: Vec3;
  /** Metres from the player. */
  distance: number;
}

/** Turns a point in the world into CSS pixels, or null when it is behind the camera. */
export type Project = (pos: Vec3) => { x: number; y: number } | null;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} element is missing`);
  return found as T;
}

function named(player: NamedPlayer): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'name';
  span.textContent = player.name;
  span.style.setProperty('--c', player.color);
  return span;
}

function clamp(value: number, limit: number): number {
  return Math.min(Math.max(value, -limit), limit);
}

/** Everything drawn over the 3D view. Player names are always set as text, never as HTML. */
export class Hud {
  private readonly root = element('hud');
  private readonly health = element('health');
  private readonly healthFill = element('health-fill');
  private readonly healthTrail = element('health-trail');
  private readonly playerCard = element('player-card');
  private readonly playerName = element('player-name');
  private readonly playerSub = element('player-sub');
  private readonly weaponCard = element('weapon-card');
  private readonly ammo = element('ammo');
  private readonly ammoMax = element('ammo-max');
  private readonly ammoCells = element('ammo-cells');
  private readonly reloadHint = element('reload-hint');
  private readonly crosshair = element('crosshair');
  private readonly feed = element('killfeed');
  private readonly damage = element('damage');
  private readonly vignette = element('vignette');
  private readonly death = element('death');
  private readonly deathTitle = element('death-title');
  private readonly deathTimer = element('death-timer');
  private readonly deathBar = element('death-bar').firstElementChild as HTMLElement;
  private readonly debug = element('debug');
  private readonly network = element('network');
  private readonly hint = element('hint');
  private readonly compassStrip = element('compass-strip');
  private readonly compassHeading = element('compass-heading');
  private readonly matchLeft = element('match-left');
  private readonly matchRight = element('match-right');
  private readonly matchClock = element('match-clock');
  private readonly tagLayer = element('tags');
  private readonly floaterLayer = element('floaters');

  // People who ask the system for less motion get a still interface.
  private readonly still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly tags = new Map<string, { root: HTMLElement; label: HTMLElement }>();
  private readonly floaters = new Set<{ root: HTMLElement; pos: Vec3 }>();
  private hitTimer = 0;
  private hp = -1;
  private ammoKey = '';
  private matchKey = '';
  private headingShown = '';
  private swayX = 0;
  private swayY = 0;

  constructor() {
    for (let degrees = 0; degrees <= STRIP_DEGREES; degrees += MARK_STEP) {
      const mark = document.createElement('span');
      mark.textContent = markLabel(degrees);
      mark.classList.toggle('point', degrees % 45 === 0);
      mark.style.left = `${degrees * EM_PER_DEGREE}em`;
      this.compassStrip.append(mark);
    }
  }

  /** The player's own card: the name and a line under it, e.g. the team and the score. */
  setPlayer(name: string, sub: string, subColor: string): void {
    if (this.playerName.textContent !== name) this.playerName.textContent = name;
    if (this.playerSub.textContent !== sub) this.playerSub.textContent = sub;
    this.playerSub.style.setProperty('--c', subColor);
  }

  setHealth(hp: number): void {
    if (hp === this.hp) return;
    const lost = hp < this.hp;
    this.hp = hp;
    this.health.textContent = String(hp);
    this.healthFill.style.width = `${hp}%`;
    // The trail follows with a delay set in CSS and shows how much was just lost.
    this.healthTrail.style.width = `${hp}%`;
    this.playerCard.classList.toggle('low', hp <= LOW_HEALTH);
    if (lost) {
      this.bump(
        this.playerCard,
        [
          { transform: 'translate(-7px, 3px)' },
          { transform: 'translate(5px, -2px)' },
          { transform: 'translate(-3px, 1px)' },
          { transform: 'translate(0, 0)' },
        ],
        260,
      );
    }
  }

  /** `reloadProgress` runs from 0 to 1 while reloading and is null otherwise. */
  setAmmo(ammo: number, magazine: number, reloadProgress: number | null): void {
    const reloading = reloadProgress !== null;
    const filled = reloading ? Math.floor(reloadProgress * magazine) : ammo;
    const key = `${ammo}/${magazine}/${filled}/${reloading}`;
    if (key === this.ammoKey) return;
    this.ammoKey = key;

    while (this.ammoCells.children.length < magazine) {
      this.ammoCells.append(document.createElement('i'));
    }
    [...this.ammoCells.children].forEach((cell, index) => {
      cell.classList.toggle('full', index < filled);
    });
    this.ammo.textContent = String(ammo);
    this.ammoMax.textContent = `/ ${magazine}`;
    const low = !reloading && ammo <= magazine / 4;
    this.weaponCard.classList.toggle('reloading', reloading);
    this.weaponCard.classList.toggle('low', low);
    this.reloadHint.hidden = !reloading && !low;
    const label = this.reloadHint.lastElementChild;
    if (label) label.textContent = reloading ? 'перезарядка…' : 'перезарядить';
  }

  /** The player's own shot: the weapon card kicks. */
  fired(): void {
    this.bump(
      this.weaponCard,
      [{ transform: 'translate(5px, 4px) scale(1.04)' }, { transform: 'translate(0, 0) scale(1)' }],
      140,
    );
  }

  /** Confirms the player's own hit; `strong` marks a headshot or a kill. */
  hitMarker(strong: boolean): void {
    this.crosshair.classList.add('hit');
    this.crosshair.classList.toggle('strong', strong);
    window.clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(
      () => this.crosshair.classList.remove('hit', 'strong'),
      HIT_MARKER_MS,
    );
  }

  /** A number that rises from the place of a hit; `pos` is a point in the world. */
  damageNumber(pos: Vec3, damage: number, head: boolean): void {
    const root = document.createElement('div');
    root.className = 'floater';
    const text = document.createElement('span');
    text.textContent = String(damage);
    text.classList.toggle('head', head);
    // Numbers of a burst must not sit exactly on top of each other.
    text.style.left = `${(Math.random() - 0.5) * 2.4}em`;
    root.append(text);
    root.hidden = true;
    this.floaterLayer.append(root);
    const floater = { root, pos };
    this.floaters.add(floater);
    window.setTimeout(() => {
      root.remove();
      this.floaters.delete(floater);
    }, DAMAGE_NUMBER_MS);
  }

  /** Labels over teammates; they are visible through walls. */
  setTags(teammates: readonly TeammateTag[], project: Project): void {
    const seen = new Set<string>();
    for (const mate of teammates) {
      seen.add(mate.id);
      let tag = this.tags.get(mate.id);
      if (!tag) {
        const root = document.createElement('div');
        root.className = 'tag';
        const label = document.createElement('span');
        root.append(label, document.createElement('i'));
        this.tagLayer.append(root);
        tag = { root, label };
        this.tags.set(mate.id, tag);
      }
      const text = `${mate.name} · ${Math.round(mate.distance)} м`;
      if (tag.label.textContent !== text) tag.label.textContent = text;
      tag.root.style.setProperty('--c', mate.color);
      this.place(tag.root, project(mate.pos));
    }
    for (const [id, tag] of this.tags) {
      if (seen.has(id)) continue;
      tag.root.remove();
      this.tags.delete(id);
    }
  }

  /** Call every frame after rendering: keeps the damage numbers on their targets. */
  updateWorld(project: Project): void {
    for (const floater of this.floaters) this.place(floater.root, project(floater.pos));
  }

  private place(root: HTMLElement, point: { x: number; y: number } | null): void {
    root.hidden = point === null;
    if (point) root.style.transform = `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`;
  }

  /** Shows where damage came from. `angle` is clockwise from straight ahead, in radians. */
  damageFrom(angle: number): void {
    const arc = document.createElement('div');
    arc.className = 'arc';
    arc.style.transform = `rotate(${angle}rad)`;
    this.damage.append(arc);
    window.setTimeout(() => arc.remove(), DAMAGE_INDICATOR_MS);

    // Restart the flash even when hits come in quick succession.
    this.vignette.classList.remove('flash');
    void this.vignette.offsetWidth;
    this.vignette.classList.add('flash');
  }

  /** `mine` highlights a line the player took part in. */
  addKill(killer: NamedPlayer, victim: NamedPlayer, head: boolean, mine: boolean): void {
    const row = document.createElement('li');
    row.classList.toggle('mine', mine);
    row.append(named(killer));
    row.insertAdjacentHTML('beforeend', WEAPON_GLYPH);
    if (head) {
      const mark = document.createElement('span');
      mark.className = 'head';
      mark.textContent = 'в голову';
      row.append(mark);
    }
    row.append(named(victim));
    this.pushFeed(row);
  }

  /** Adds a line of plain text to the kill feed, e.g. a team change. */
  addNotice(player: NamedPlayer, text: string): void {
    const row = document.createElement('li');
    row.className = 'notice';
    row.append(named(player), text);
    this.pushFeed(row);
  }

  private pushFeed(row: HTMLElement): void {
    this.feed.prepend(row);
    while (this.feed.children.length > KILL_FEED_SIZE) this.feed.lastElementChild?.remove();
    window.setTimeout(() => row.remove(), KILL_FEED_TTL_MS);
  }

  /**
   * Shows the death screen, or hides it when `cause` is null. The cause is the
   * killer, or a plain explanation when nobody killed the player.
   */
  setDeath(cause: NamedPlayer | string | null, secondsLeft = 0, totalSeconds = 1): void {
    this.death.hidden = cause === null;
    this.root.classList.toggle('dead', cause !== null);
    if (cause === null) return;
    this.deathTitle.textContent = '';
    if (typeof cause === 'string') this.deathTitle.append(cause);
    else this.deathTitle.append('Вас устранил ', named(cause));
    const left = Math.max(secondsLeft, 0);
    this.deathTimer.textContent = `Возрождение через ${Math.ceil(left)}`;
    this.deathBar.style.width = `${Math.min(Math.max(1 - left / totalSeconds, 0), 1) * 100}%`;
  }

  /** The line under the compass: a clock or a status between two scores. */
  setMatch(clock: string, left: MatchSide | null, right: MatchSide | null): void {
    const key = JSON.stringify([clock, left, right]);
    if (key === this.matchKey) return;
    this.matchKey = key;
    this.matchClock.textContent = clock;
    for (const [root, side] of [
      [this.matchLeft, left],
      [this.matchRight, right],
    ] as const) {
      root.hidden = side === null;
      if (!side) continue;
      root.style.setProperty('--c', side.color);
      const label = root.querySelector('.label');
      const score = root.querySelector('b');
      if (label) label.textContent = side.label;
      if (score) score.textContent = side.score;
    }
  }

  setHeading(yaw: number): void {
    // Laid out twice over, the strip always has marks on both sides of the middle.
    const degrees = heading(yaw);
    const centre = degrees < 180 ? degrees + 360 : degrees;
    this.compassStrip.style.transform = `translateX(${(-centre * EM_PER_DEGREE).toFixed(3)}em)`;
    const text = headingText(yaw);
    if (text !== this.headingShown) {
      this.headingShown = text;
      this.compassHeading.textContent = text;
    }
  }

  /**
   * Makes the cards trail behind the camera. `dYaw` and `dPitch` are how far the
   * view turned since the previous frame, `dt` seconds ago.
   */
  sway(dYaw: number, dPitch: number, dt: number): void {
    if (this.still || dt <= 0) return;
    const blend = 1 - Math.exp(-SWAY_RATE * dt);
    const targetX = clamp((dYaw / dt) * SWAY_PER_RAD_S, SWAY_MAX_PX);
    const targetY = clamp((dPitch / dt) * SWAY_PER_RAD_S, SWAY_MAX_PX);
    this.swayX += (targetX - this.swayX) * blend;
    this.swayY += (targetY - this.swayY) * blend;
    this.root.style.setProperty('--sway-x', this.swayX.toFixed(2));
    this.root.style.setProperty('--sway-y', this.swayY.toFixed(2));
  }

  /** Shows a connection problem over the game; an empty string hides it. */
  setNetworkStatus(text: string): void {
    this.network.textContent = text;
    this.network.hidden = text === '';
  }

  /** Shows a prompt in the middle of the screen; an empty string hides it. */
  setHint(text: string): void {
    this.hint.textContent = text;
    this.hint.hidden = text === '';
  }

  setDebug(text: string): void {
    if (this.debug.textContent !== text) this.debug.textContent = text;
  }

  /** A short one-off movement of a card; the card's own tilt lives on its parent. */
  private bump(card: HTMLElement, frames: Keyframe[], duration: number): void {
    if (this.still) return;
    card.firstElementChild?.animate(frames, { duration, easing: 'ease-out' });
  }
}
