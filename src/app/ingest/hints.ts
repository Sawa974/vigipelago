import type { Hint } from '../protocol/types';

// Rattrapage des hints par le data storage, qui ne garde aucune date : horodatage `approx`.

export function hintsKey(team: number, slot: number): string {
  return `_read_hints_${team}_${slot}`;
}

export function parseHintsKey(key: string): { team: number; slot: number } | null {
  const m = /^_read_hints_(\d+)_(\d+)$/.exec(key);
  return m ? { team: Number(m[1]), slot: Number(m[2]) } : null;
}

/** Ni texte ni instant dans la cle : le rattrapage doit rester idempotent. */
export function hintDedupSuffix(team: number, findingPlayer: number, location: number): string {
  return `h:${team}:${findingPlayer}:${location}`;
}

export interface HintGap {
  srcSlot: number;
  dstSlot: number;
  itemId: number;
  locationId: number;
  itemFlags: number;
  entrance: string;
  dedupSuffix: string;
  tsLower: number;
  tsUpper: number;
  /** Milieu des bornes : pour le tri, jamais affiche comme instant. */
  ts: number;
}

export interface HintGapsInput {
  team: number;
  hints: readonly Hint[];
  knownSuffixes: ReadonlySet<string>;
  tsLower: number;
  tsUpper: number;
}

export function computeHintGaps(input: HintGapsInput): HintGap[] {
  const { team, hints, knownSuffixes } = input;
  const tsUpper = input.tsUpper;
  const tsLower = Math.min(input.tsLower, tsUpper);
  const ts = Math.round((tsLower + tsUpper) / 2);

  const seen = new Set<string>();
  const out: HintGap[] = [];

  for (const h of hints) {
    // Un hint honore s'afficherait « en attente » si son check nous est inconnu.
    if (h.found) continue;
    if (
      typeof h.finding_player !== 'number' ||
      typeof h.receiving_player !== 'number' ||
      typeof h.location !== 'number' ||
      typeof h.item !== 'number'
    ) {
      continue;
    }
    const dedupSuffix = hintDedupSuffix(team, h.finding_player, h.location);
    // Stocke sous les deux joueurs : chaque hint arrive deux fois.
    if (seen.has(dedupSuffix) || knownSuffixes.has(dedupSuffix)) continue;
    seen.add(dedupSuffix);
    out.push({
      srcSlot: h.finding_player,
      dstSlot: h.receiving_player,
      itemId: h.item,
      locationId: h.location,
      itemFlags: h.item_flags ?? 0,
      entrance: h.entrance ?? '',
      dedupSuffix,
      tsLower,
      tsUpper,
      ts,
    });
  }

  return out;
}
