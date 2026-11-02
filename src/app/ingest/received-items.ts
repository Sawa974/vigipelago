import type { NetworkItem } from '../protocol/types';

// Rattrapage des objets recus depuis le `ReceivedItems` d'index 0, compare au journal.

/** Meme seuil que le decodage des `PrintJSON`, sinon un objet recoit deux cles. */
export function isPlaced(item: NetworkItem): boolean {
  return item.location >= 0;
}

/** Identique a la cle du check correspondant : les deux rattrapages doivent converger. */
export function placedDedupKey(roomId: string, team: number, srcSlot: number, locationId: number): string {
  return `${roomId}|i:${team}:${srcSlot}:${locationId}`;
}

/** Le rang dans la liste du serveur tient lieu de location : elle ne fait que s'allonger. */
export function unplacedDedupKey(roomId: string, team: number, dstSlot: number, index: number): string {
  return `${roomId}|ri:${team}:${dstSlot}:${index}`;
}

export interface ReceivedItemGap {
  index: number;
  itemId: number;
  flags: number;
  srcSlot: number | null;
  locationId: number | null;
  dedupKey: string;
  tsLower: number;
  tsUpper: number;
  /** Milieu des bornes : pour le tri, jamais affiche comme instant. */
  ts: number;
}

export interface ReceivedItemsInput {
  roomId: string;
  team: number;
  dstSlot: number;
  items: readonly NetworkItem[];
  /** Toutes precisions confondues. */
  knownKeys: ReadonlySet<string>;
  tsLower: number;
  tsUpper: number;
}

export function computeReceivedGaps(input: ReceivedItemsInput): ReceivedItemGap[] {
  const { roomId, team, dstSlot, items, knownKeys } = input;
  const tsUpper = input.tsUpper;
  const tsLower = Math.min(input.tsLower, tsUpper);
  const ts = Math.round((tsLower + tsUpper) / 2);

  const out: ReceivedItemGap[] = [];
  const seen = new Set<string>();

  items.forEach((item, index) => {
    const placed = isPlaced(item);
    const dedupKey = placed
      ? placedDedupKey(roomId, team, item.player, item.location)
      : unplacedDedupKey(roomId, team, dstSlot, index);
    if (knownKeys.has(dedupKey) || seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push({
      index,
      itemId: item.item,
      flags: item.flags,
      srcSlot: placed ? item.player : null,
      locationId: placed ? item.location : null,
      dedupKey,
      tsLower,
      tsUpper,
      ts,
    });
  });
  return out;
}
