import constants from '@shared/constants.json';

/** Names of the weapons, in the order of `weapons` in shared/constants.json. */
export const WEAPON_NAMES = ['Пулемёт', 'Дробовик', 'Ракетница', 'Рельсотрон'];

const AMMO_NAMES = ['Патроны', 'Дробь', 'Ракеты', 'Заряды'];

const TYPES: Record<string, { kind: string; weapon: number; amount: number }> =
  constants.items.types;

/** What the player is told on picking an item up. */
export function itemLabel(type: string): string {
  const spec = TYPES[type];
  switch (spec?.kind) {
    case 'weapon':
      return WEAPON_NAMES[spec.weapon] ?? '';
    case 'ammo':
      return AMMO_NAMES[spec.weapon] ?? '';
    case 'health':
      return `+${spec.amount} здоровья`;
    case 'armor':
      return `+${spec.amount} брони`;
    case 'quad':
      return `Quad Damage — урон ×${constants.combat.quadMultiplier}`;
    default:
      return '';
  }
}

/** Kind of an item of the map: `weapon`, `ammo`, `health`, `armor` or `quad`. */
export function itemKind(type: string): string {
  return TYPES[type]?.kind ?? '';
}
