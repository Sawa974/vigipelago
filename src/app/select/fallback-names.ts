import type { Translate } from '../i18n/translate';

/** Ce qui s'affiche quand le DataPackage ou la liste des joueurs ne nomme pas encore un id. */
export interface FallbackNames {
  slot(slot: number): string;
  item(id: number): string;
  location(id: number): string;
}

/** Sans interface : les tests, et le service avant que la langue soit branchee. */
export const DEFAULT_FALLBACK_NAMES: FallbackNames = {
  slot: (slot) => `Slot ${slot}`,
  item: (id) => `Item ${id}`,
  location: (id) => `Location ${id}`,
};

export function fallbackNames(t: Translate): FallbackNames {
  return {
    slot: (slot) => t('name.slot', { slot }),
    item: (id) => t('name.item', { id }),
    location: (id) => t('name.location', { id }),
  };
}
