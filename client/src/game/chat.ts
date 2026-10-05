import constants from '@shared/constants.json';
import { named, type NamedPlayer } from './hud';

const LOG_SIZE = 8;
// A line stays on screen this long; opening the chat brings the recent ones back.
const LINE_TTL_MS = 10000;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} element is missing`);
  return found as T;
}

/** The room chat: the latest lines and the field to type one. Text is never set as HTML. */
export class Chat {
  private readonly root = element('chat');
  private readonly log = element('chat-log');
  private readonly field = element<HTMLInputElement>('chat-input');
  private opened = false;

  /** `onToggle` is told when typing starts and ends, so the keys stop being game input. */
  constructor(
    private readonly onSend: (text: string) => void,
    private readonly onToggle: (open: boolean) => void,
  ) {
    this.field.maxLength = constants.chat.maxLength;
    // A click in the game takes the focus away; treat that as giving up on the line.
    this.field.addEventListener('blur', () => this.close());
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.root.classList.add('open');
    this.field.value = '';
    this.field.hidden = false;
    this.field.focus();
    this.onToggle(true);
  }

  /** Hides the field and drops what was typed. */
  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.classList.remove('open');
    this.field.hidden = true;
    this.field.blur();
    this.onToggle(false);
  }

  /** Sends what was typed, if anything, and closes the field. */
  submit(): void {
    const text = this.field.value.trim();
    this.close();
    if (text) this.onSend(text);
  }

  add(player: NamedPlayer, text: string): void {
    const row = document.createElement('li');
    const body = document.createElement('span');
    body.textContent = text;
    row.append(named(player), body);
    this.log.append(row);
    while (this.log.children.length > LOG_SIZE) this.log.firstElementChild?.remove();
    window.setTimeout(() => row.classList.add('old'), LINE_TTL_MS);
  }
}
