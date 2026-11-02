import { ITEM_FLAG_PROGRESSION, ITEM_FLAG_TRAP, ITEM_FLAG_USEFUL } from './types';
import type { Key } from '../i18n/en';

export type ItemClass = 'progression' | 'useful' | 'trap' | 'filler';

/** Drapeaux cumulables, le piege lu en premier ; `null` est inconnu, pas `filler`. */
export function itemClassOf(flags: number | null | undefined): ItemClass | null {
  if (flags === null || flags === undefined) return null;
  if (flags & ITEM_FLAG_TRAP) return 'trap';
  if (flags & ITEM_FLAG_PROGRESSION) return 'progression';
  if (flags & ITEM_FLAG_USEFUL) return 'useful';
  return 'filler';
}

export const ITEM_CLASSES: ItemClass[] = ['progression', 'useful', 'filler', 'trap'];

export const ITEM_CLASS_LABEL: Record<ItemClass, Key> = {
  progression: 'itemClass.progression',
  useful: 'itemClass.useful',
  filler: 'itemClass.filler',
  trap: 'itemClass.trap',
};

/** La couleur seule ne porte jamais l'information. */
export const ITEM_CLASS_GLYPH: Record<ItemClass, string> = {
  progression: '✦',
  useful: '◆',
  filler: '·',
  trap: '▼',
};

export function itemClassCss(cls: ItemClass | null): string {
  return cls ? `item-${cls}` : 'item-unknown';
}
