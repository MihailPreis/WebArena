import constants from '@shared/constants.json';
import { ApiError, updateMe, type Profile } from './api';
import type { Session } from './session';

const PROFILE = constants.profile;

export interface ProfileEditorOptions {
  session: Session;
  nameInput: HTMLInputElement;
  /** Container the colour swatches are added to. */
  colors: HTMLElement;
  message: HTMLElement;
  serverDown: string;
  onChange?: (profile: Profile) => void;
}

/** Wires up the name field and the colour swatches; every change is saved at once. */
export function setupProfileEditor(options: ProfileEditorOptions): void {
  const { session, nameInput, colors, message } = options;
  let profile = session.profile;
  nameInput.maxLength = PROFILE.nameMaxLength;

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
    message.className = 'message';
    try {
      const saved = await updateMe(session.token, update);
      show(saved);
      message.textContent = 'Сохранено';
      message.classList.add('ok');
      options.onChange?.(saved);
    } catch (error) {
      show(profile);
      if (error instanceof ApiError && error.status === 422) {
        message.textContent =
          update.color !== undefined
            ? 'Цвет слишком тёмный — выберите светлее.'
            : `Имя: от 1 до ${PROFILE.nameMaxLength} символов.`;
      } else {
        message.textContent = options.serverDown;
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
