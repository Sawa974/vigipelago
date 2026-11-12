import type { ApEvent, EventKind } from '../db/db';
import { matchesSearch, normalizeQuery } from './feed-search';

export const FEED_CATEGORIES = ['items', 'goals', 'hints', 'deaths', 'chat', 'server'] as const;
export type FeedCategory = (typeof FEED_CATEGORIES)[number];

/** Chaque type tombe dans une categorie : tout cocher montre donc tout. */
const CATEGORY_OF: Record<EventKind, FeedCategory> = {
  item: 'items',
  goal: 'goals',
  release: 'goals',
  collect: 'goals',
  hint: 'hints',
  death: 'deaths',
  chat: 'chat',
  join: 'server',
  part: 'server',
  tags: 'server',
  server: 'server',
  countdown: 'server',
  command: 'server',
  tutorial: 'server',
  system: 'server',
};

export interface FeedFilter {
  categories: ReadonlySet<FeedCategory>;
  /** Le slot coche, `null` quand la case est decochee ou le slot inconnu. */
  slot: number | null;
}

/** Rien de coche, ou toutes les categories cochees : aucun filtre. */
export function isFilterActive(f: FeedFilter): boolean {
  if (f.categories.size === FEED_CATEGORIES.length) return false;
  return f.categories.size > 0 || f.slot !== null;
}

/** Les cases s'additionnent : une ligne passe si une seule d'entre elles la retient. */
export function matchesFilter(e: ApEvent, f: FeedFilter): boolean {
  if (!isFilterActive(f)) return true;
  if (f.categories.has(CATEGORY_OF[e.kind])) return true;
  return f.slot !== null && (e.srcSlot === f.slot || e.dstSlot === f.slot);
}

/** `null` quand ni texte ni case ne restreignent : le journal vif suffit. */
export function feedMatcher(text: string, f: FeedFilter): ((e: ApEvent) => boolean) | null {
  const q = normalizeQuery(text);
  const filtered = isFilterActive(f);
  if (!q && !filtered) return null;
  return (e) => (!q || matchesSearch(e, q)) && (!filtered || matchesFilter(e, f));
}
