import type { ApEvent } from '../db/db';

/** Partagee par la requete en base et le filtre des lignes vives : ne pas la dupliquer. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function matchesSearch(e: ApEvent, normalizedQuery: string): boolean {
  return e.text.toLowerCase().includes(normalizedQuery);
}

/** Les deux listes doivent etre triees par instant croissant ; `dedupKey` fait l'identite. */
export function mergeSearchWithLive(
  base: readonly ApEvent[],
  live: readonly ApEvent[],
  normalizedQuery: string,
): ApEvent[] {
  if (!normalizedQuery) return [...base];
  const seen = new Set<string>();
  for (const e of base) seen.add(e.dedupKey);

  const extra: ApEvent[] = [];
  for (const e of live) {
    if (seen.has(e.dedupKey) || !matchesSearch(e, normalizedQuery)) continue;
    seen.add(e.dedupKey);
    extra.push(e);
  }
  if (!extra.length) return [...base];

  const out: ApEvent[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length && j < extra.length) {
    // A instant egal, la base passe d'abord.
    out.push(extra[j].ts < base[i].ts ? extra[j++] : base[i++]);
  }
  while (i < base.length) out.push(base[i++]);
  while (j < extra.length) out.push(extra[j++]);
  return out;
}
