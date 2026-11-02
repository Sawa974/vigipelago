export const VIGIPELAGO_TAG = 'Vigipelago';
/** L'ancien nom reste : les journaux et exports anterieurs au renommage le portent. */
const FORMER_TAGS = new Set([VIGIPELAGO_TAG, 'Mychipelago']);

export const OBSERVER_TAGS = new Set(['TextOnly', 'Tracker', 'HintGame']);

export type ClientClass =
  /** La notre, ou celle de quelqu'un d'autre. */
  | 'self'
  | 'observer'
  /** Par defaut, y compris sans aucun tag. */
  | 'player';

export function classifyTags(tags: readonly string[] | null | undefined): ClientClass {
  if (!tags) return 'player';
  if (tags.some((t) => FORMER_TAGS.has(t))) return 'self';
  return tags.some((t) => OBSERVER_TAGS.has(t)) ? 'observer' : 'player';
}
