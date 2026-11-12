// `checked_locations` ne concerne que le slot connecte : les trous des autres slots restent.

export interface GapCheck {
  locationId: number;
  /** `null` : rien ne borne le check par le bas, il precede peut-etre toute ecoute. */
  tsLower: number | null;
  tsUpper: number;
  /** Milieu des bornes : pour le tri, jamais affiche comme instant. */
  ts: number;
}

export interface ReconcileInput {
  checkedLocations: readonly number[];
  knownLocationIds: ReadonlySet<number>;
  tsLower: number | null;
  tsUpper: number;
}

/** Contre les locations resolues, pas connues : une ligne sans contenu doit etre rescoutee. */
export function selectScoutTargets(input: {
  checkedLocations: readonly number[];
  resolvedLocationIds: ReadonlySet<number>;
}): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of input.checkedLocations) {
    if (input.resolvedLocationIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function computeGapChecks(input: ReconcileInput): GapCheck[] {
  const { checkedLocations, knownLocationIds, tsUpper } = input;
  const tsLower = input.tsLower === null ? null : Math.min(input.tsLower, tsUpper);
  const ts = tsLower === null ? tsUpper : Math.round((tsLower + tsUpper) / 2);

  const out: GapCheck[] = [];
  for (const locationId of checkedLocations) {
    if (knownLocationIds.has(locationId)) continue;
    out.push({ locationId, tsLower, tsUpper, ts });
  }
  return out.sort((a, b) => a.locationId - b.locationId);
}
