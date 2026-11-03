export interface Interval {
  from: number;
  to: number;
}

export interface SessionBounds {
  startedAt: number;
  /** `null` tant que la session est vivante. */
  endedAt: number | null;
  lastHeartbeatAt: number;
}

/** Une session jamais fermee proprement s'arrete a son dernier battement, sauf la vivante. */
export function mergeCoverage(sessions: SessionBounds[], now: number): Interval[] {
  const raw = sessions
    .map((s) => ({
      from: s.startedAt,
      to: s.endedAt ?? Math.max(s.lastHeartbeatAt, s.startedAt),
    }))
    .filter((i) => i.to >= i.from)
    .sort((a, b) => a.from - b.from);

  const merged: Interval[] = [];
  for (const cur of raw) {
    const last = merged[merged.length - 1];
    if (last && cur.from <= last.to) {
      last.to = Math.max(last.to, cur.to);
    } else {
      merged.push({ ...cur });
    }
  }
  const tail = merged[merged.length - 1];
  if (tail && sessions.some((s) => s.endedAt === null && s.startedAt === tail.from)) {
    tail.to = Math.max(tail.to, now);
  }
  return merged;
}

export function gapsWithin(coverage: Interval[], from: number, to: number): Interval[] {
  const gaps: Interval[] = [];
  let cursor = from;
  for (const c of coverage) {
    if (c.to <= from) continue;
    if (c.from >= to) break;
    if (c.from > cursor) gaps.push({ from: cursor, to: Math.min(c.from, to) });
    cursor = Math.max(cursor, c.to);
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push({ from: cursor, to });
  return gaps.filter((g) => g.to > g.from);
}

export function lastCoveredBefore(coverage: Interval[], t: number): number | null {
  let best: number | null = null;
  for (const c of coverage) {
    if (c.from >= t) break;
    best = Math.min(c.to, t);
  }
  return best;
}

/** La fin d'une session coupee : son dernier paquet, jamais avant son debut ni apres maintenant. */
export function sessionEndAt(startedAt: number, lastHeardAt: number | null, now: number): number {
  return Math.min(now, Math.max(startedAt, lastHeardAt ?? now));
}

export function gapDuration(coverage: Interval[], from: number, to: number): number {
  return gapsWithin(coverage, from, to).reduce((sum, g) => sum + (g.to - g.from), 0);
}
