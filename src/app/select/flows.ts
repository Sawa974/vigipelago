import type { ApEvent } from '../db/db';

/** Aligne sur `MAX_COMBINED_SERIES` du cumule. */
export const FLOW_ROW_LIMIT = 8;

export interface FlowRow {
  /** `null` pour la ligne de regroupement. */
  slot: number | null;
  name: string;
  count: number;
  /** Part du total affiche, pas un avancement. */
  share: number;
  players: number;
}

export interface Flows {
  sent: FlowRow[];
  received: FlowRow[];
  sentTotal: number;
  receivedTotal: number;
  /** Avant tout regroupement. */
  sentPartners: number;
  receivedPartners: number;
  /** Hors de `receivedTotal` et jamais dans « autres », qui designe des joueurs reels. */
  unplacedReceived: number;
}

export interface FlowsInput {
  /** Deja filtres sur `srcSlot`. */
  outbound: readonly ApEvent[];
  /** Deja filtres sur `dstSlot`. */
  inbound: readonly ApEvent[];
  slot: number;
  names: ReadonlyMap<number, string>;
}

export function buildFlows(input: FlowsInput): Flows {
  const sentBy = new Map<number, number>();
  for (const e of input.outbound) {
    if (e.kind !== 'item' || e.dstSlot === null) continue;
    sentBy.set(e.dstSlot, (sentBy.get(e.dstSlot) ?? 0) + 1);
  }

  const receivedFrom = new Map<number, number>();
  let unplacedReceived = 0;
  for (const e of input.inbound) {
    if (e.kind !== 'item') continue;
    if (e.srcSlot === null) {
      unplacedReceived++;
      continue;
    }
    receivedFrom.set(e.srcSlot, (receivedFrom.get(e.srcSlot) ?? 0) + 1);
  }

  return {
    sent: toRows(sentBy, input.names),
    received: toRows(receivedFrom, input.names),
    sentTotal: sum(sentBy),
    receivedTotal: sum(receivedFrom),
    sentPartners: sentBy.size,
    receivedPartners: receivedFrom.size,
    unplacedReceived,
  };
}

function sum(m: ReadonlyMap<number, number>): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

function toRows(counts: ReadonlyMap<number, number>, names: ReadonlyMap<number, string>): FlowRow[] {
  const total = sum(counts);
  const sorted = [...counts.entries()].sort(
    (a, b) =>
      b[1] - a[1] ||
      (names.get(a[0]) ?? `Slot ${a[0]}`).localeCompare(names.get(b[0]) ?? `Slot ${b[0]}`, 'fr'),
  );

  const share = (n: number) => (total ? n / total : 0);
  // `+ 1` : un reste d'un seul joueur se nomme au lieu d'etre regroupe.
  if (sorted.length <= FLOW_ROW_LIMIT + 1) {
    return sorted.map(([slot, count]) => ({
      slot,
      name: names.get(slot) ?? `Slot ${slot}`,
      count,
      share: share(count),
      players: 1,
    }));
  }

  const head = sorted.slice(0, FLOW_ROW_LIMIT);
  const tail = sorted.slice(FLOW_ROW_LIMIT);
  const tailCount = tail.reduce((n, [, c]) => n + c, 0);
  return [
    ...head.map(([slot, count]) => ({
      slot,
      name: names.get(slot) ?? `Slot ${slot}`,
      count,
      share: share(count),
      players: 1,
    })),
    {
      slot: null,
      // Nomme par l'ecran, d'apres `players`.
      name: '',
      count: tailCount,
      share: share(tailCount),
      players: tail.length,
    },
  ];
}
