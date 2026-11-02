// Protocole : disabled 0b000, enabled 0b001, goal 0b010, auto 0b110, auto_enabled 0b111.

const BIT_MANUAL = 0b001;
const BIT_AFTER_GOAL = 0b010;

export type ManualUse = 'oui' | 'apres-objectif' | 'non';

/** Absente : `'inconnu'` et non `'non'`. */
export function manualUse(value: number | undefined): ManualUse | 'inconnu' {
  if (value === undefined) return 'inconnu';
  if (value & BIT_MANUAL) return 'oui';
  if (value & BIT_AFTER_GOAL) return 'apres-objectif';
  return 'non';
}

const BIT_AUTO = 0b100;

export type PermissionRule = 'disabled' | 'manual' | 'afterGoal' | 'auto' | 'autoManual';

/** Une valeur hors des cinq du protocole se lit par ses bits, sans etre rejetee. */
export function permissionRule(value: number | null | undefined): PermissionRule | null {
  if (value === null || value === undefined) return null;
  if (value & BIT_AUTO) return value & BIT_MANUAL ? 'autoManual' : 'auto';
  if (value & BIT_MANUAL) return 'manual';
  if (value & BIT_AFTER_GOAL) return 'afterGoal';
  return 'disabled';
}
