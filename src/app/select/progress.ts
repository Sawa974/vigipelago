import type { ApEvent, SlotStats } from '../db/db';
import {
  ITEM_CLASSES,
  ITEM_CLASS_LABEL,
  itemClassOf,
  type ItemClass,
} from '../protocol/item-class';
import type { Translate } from '../i18n/translate';

// Les objets recus par joueur sont un compte, jamais un X/Y : le total serait du spoiler.

/** `unknown` : contenu jamais resolu, distinct de « objet banal ». */
export type ClassTally = Record<ItemClass | 'unknown', number>;

function emptyTally(): ClassTally {
  return { progression: 0, useful: 0, filler: 0, trap: 0, unknown: 0 };
}

export interface EventCounts {
  checksBySlot: Map<number, number>;
  approxChecksBySlot: Map<number, number>;
  itemsReceivedBySlot: Map<number, number>;
  itemsByClassBySlot: Map<number, ClassTally>;
  /** Hors location : n'entre dans aucun X/Y qui compte des locations. */
  unplacedItems: number;
}

export function countEvents(events: readonly ApEvent[]): EventCounts {
  const checksBySlot = new Map<number, number>();
  const approxChecksBySlot = new Map<number, number>();
  const itemsReceivedBySlot = new Map<number, number>();
  const itemsByClassBySlot = new Map<number, ClassTally>();
  let unplacedItems = 0;

  for (const e of events) {
    if (e.kind !== 'item') continue;
    if (e.srcSlot === null && e.dstSlot !== null) unplacedItems++;
    if (e.srcSlot !== null) {
      bump(checksBySlot, e.srcSlot);
      if (e.tsPrecision === 'approx') bump(approxChecksBySlot, e.srcSlot);
    }
    if (e.dstSlot !== null) {
      bump(itemsReceivedBySlot, e.dstSlot);
      let tally = itemsByClassBySlot.get(e.dstSlot);
      if (!tally) {
        tally = emptyTally();
        itemsByClassBySlot.set(e.dstSlot, tally);
      }
      tally[itemClassOf(e.itemFlags) ?? 'unknown']++;
    }
  }
  return { checksBySlot, approxChecksBySlot, itemsReceivedBySlot, itemsByClassBySlot, unplacedItems };
}

function bump(m: Map<number, number>, k: number): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/** Parmi ce qui est trouve, pas la composition de la seed. */
export interface ClassTotals {
  byClass: ClassTally;
  total: number;
}

export function buildClassTotals(counts: EventCounts): ClassTotals {
  const byClass = emptyTally();
  for (const tally of counts.itemsByClassBySlot.values()) {
    for (const k of Object.keys(byClass) as (keyof ClassTally)[]) byClass[k] += tally[k];
  }
  const total = Object.values(byClass).reduce((n, v) => n + v, 0);
  return { byClass, total };
}

export interface SlotProgress {
  slot: number;
  name: string;
  game: string;
  checked: number;
  /** `null` tant que le slot n'a pas ete interroge. */
  total: number | null;
  ratio: number | null;
  /** Un nombre de checks, pas une proportion. */
  approx: number;
  itemsReceived: number;
  byClass: ClassTally;
}

/** `serverFloor` faux en relecture : `checkedFromServer` est un instantane de maintenant. */
export function buildProgress(
  players: readonly { slot: number; name: string; game: string }[],
  stats: ReadonlyMap<number, SlotStats>,
  counts: EventCounts,
  opts: { serverFloor: boolean } = { serverFloor: true },
): SlotProgress[] {
  return players.map((p) => {
    const st = stats.get(p.slot);
    const journal = counts.checksBySlot.get(p.slot) ?? 0;
    const floor = opts.serverFloor ? (st?.checkedFromServer ?? 0) : 0;
    const checked = Math.max(journal, floor);
    const total = st?.totalLocations ?? null;
    return {
      slot: p.slot,
      name: p.name,
      game: p.game,
      checked,
      total,
      ratio: total ? Math.min(1, checked / total) : null,
      approx: counts.approxChecksBySlot.get(p.slot) ?? 0,
      itemsReceived: counts.itemsReceivedBySlot.get(p.slot) ?? 0,
      byClass: counts.itemsByClassBySlot.get(p.slot) ?? emptyTally(),
    };
  });
}

/** Denominateur : somme des totaux connus, une borne basse tant qu'un slot manque. */
export interface MultiworldItems {
  placed: number;
  found: number;
  /** Le numerateur du ratio, et non `found` : meme perimetre que `placed`. */
  foundInKnown: number;
  ratio: number | null;
  slotsUnknown: number;
  unplaced: number;
}

export function buildMultiworldItems(
  progress: readonly SlotProgress[],
  counts: EventCounts,
): MultiworldItems {
  let placed = 0;
  let found = 0;
  let foundInKnown = 0;
  let slotsUnknown = 0;
  for (const p of progress) {
    found += p.checked;
    if (p.total === null) {
      slotsUnknown++;
      continue;
    }
    placed += p.total;
    foundInKnown += p.checked;
  }
  return {
    placed,
    found,
    foundInKnown,
    ratio: placed ? Math.min(1, foundInKnown / placed) : null,
    slotsUnknown,
    unplaced: counts.unplacedItems,
  };
}

/** Partage par les deux rendus de la ventilation : ne pas dupliquer le calcul. */
export interface ClassSegment {
  key: ItemClass | 'unknown';
  cls: string;
  pct: number;
  title: string;
}

export function classSegments(t: ClassTally, tr: Translate): ClassSegment[] {
  const keys: (ItemClass | 'unknown')[] = [...ITEM_CLASSES, 'unknown'];
  const total = keys.reduce((s, k) => s + t[k], 0);
  if (!total) return [];
  return keys
    .filter((k) => t[k] > 0)
    .map((k) => ({
      key: k,
      cls: `cseg c-${k}`,
      pct: (t[k] / total) * 100,
      title: tr('itemClass.tally', {
        label: tr(k === 'unknown' ? 'itemClass.unknown' : ITEM_CLASS_LABEL[k]),
        count: t[k],
      }),
    }));
}
