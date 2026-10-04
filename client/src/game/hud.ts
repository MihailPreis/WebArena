const KILL_FEED_SIZE = 5;
const KILL_FEED_TTL_MS = 6000;
const HIT_MARKER_MS = 140;
const DAMAGE_INDICATOR_MS = 1000;

export interface NamedPlayer {
  name: string;
  color: string;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} element is missing`);
  return found as T;
}

/** Everything drawn over the 3D view. Player names are always set as text, never as HTML. */
export class Hud {
  private readonly health = element('health');
  private readonly ammo = element('ammo');
  private readonly crosshair = element('crosshair');
  private readonly feed = element('killfeed');
  private readonly damage = element('damage');
  private readonly vignette = element('vignette');
  private readonly death = element('death');
  private readonly deathTitle = element('death-title');
  private readonly deathTimer = element('death-timer');
  private readonly debug = element('debug');
  private readonly network = element('network');
  private readonly hint = element('hint');
  private hitTimer = 0;

  setHealth(hp: number): void {
    this.health.textContent = String(hp);
    this.health.classList.toggle('low', hp <= 30);
  }

  setAmmo(ammo: number, magazine: number, reloading: boolean): void {
    this.ammo.textContent = reloading ? 'перезарядка' : `${ammo} / ${magazine}`;
    this.ammo.classList.toggle('low', !reloading && ammo <= magazine / 4);
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

  /** Shows where damage came from. `angle` is clockwise from straight ahead, in radians. */
  damageFrom(angle: number): void {
    const wedge = document.createElement('div');
    wedge.className = 'wedge';
    wedge.style.transform = `rotate(${angle}rad)`;
    this.damage.append(wedge);
    window.setTimeout(() => wedge.remove(), DAMAGE_INDICATOR_MS);

    // Restart the flash even when hits come in quick succession.
    this.vignette.classList.remove('flash');
    void this.vignette.offsetWidth;
    this.vignette.classList.add('flash');
  }

  addKill(killer: NamedPlayer, victim: NamedPlayer, head: boolean): void {
    const row = document.createElement('li');
    const name = (player: NamedPlayer) => {
      const span = document.createElement('span');
      span.textContent = player.name;
      span.style.color = player.color;
      return span;
    };
    row.append(name(killer), head ? ' ✕ в голову ✕ ' : ' ✕ ', name(victim));
    this.feed.append(row);
    while (this.feed.children.length > KILL_FEED_SIZE) this.feed.firstElementChild?.remove();
    window.setTimeout(() => row.remove(), KILL_FEED_TTL_MS);
  }

  /** Adds a line of plain text to the kill feed, e.g. a team change. */
  addNotice(player: NamedPlayer, text: string): void {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = player.name;
    name.style.color = player.color;
    row.append(name, ` ${text}`);
    this.feed.append(row);
    while (this.feed.children.length > KILL_FEED_SIZE) this.feed.firstElementChild?.remove();
    window.setTimeout(() => row.remove(), KILL_FEED_TTL_MS);
  }

  /**
   * Shows the death screen, or hides it when `cause` is null. The cause is the
   * killer, or a plain explanation when nobody killed the player.
   */
  setDeath(cause: NamedPlayer | string | null, secondsLeft = 0): void {
    this.death.hidden = cause === null;
    if (cause === null) return;
    this.deathTitle.textContent = '';
    if (typeof cause === 'string') {
      this.deathTitle.append(cause);
    } else {
      const name = document.createElement('span');
      name.textContent = cause.name;
      name.style.color = cause.color;
      this.deathTitle.append('Вас убил ', name);
    }
    this.deathTimer.textContent = `Возрождение через ${Math.max(Math.ceil(secondsLeft), 0)}`;
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
    this.debug.textContent = text;
  }
}
