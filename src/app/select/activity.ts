import type { ApEvent } from '../db/db';
import type { Interval } from '../ingest/coverage';

// Activite deduite des checks seuls : une connexion ne dit pas qu'on joue.

export const ACTIVITY_GAP_MS = 15 * 60_000;

export interface ActivityRun {
  from: number;
  /** Le dernier check : la plage ne s'etend pas au-dela. */
  to: number;
  checks: number;
}

export interface ActivityLane {
  slot: number;
  runs: ActivityRun[];
  checks: number;
  unplaced: number;
  /** Toutes fenetres confondues. */
  lastCheckAt: number | null;
}

export function buildActivity(
  events: readonly ApEvent[],
  slots: readonly number[],
  window: Interval,
  toleranceMs: number = ACTIVITY_GAP_MS,
): ActivityLane[] {
  const bySlot = new Map<number, number[]>();
  const unplaced = new Map<number, number>();
  const lastCheck = new Map<number, number>();
  for (const s of slots) bySlot.set(s, []);

  for (const e of events) {
    if (e.kind !== 'item' || e.srcSlot === null) continue;
    const list = bySlot.get(e.srcSlot);
    if (!list) continue;

    if (e.tsPrecision === 'approx') {
      if ((e.tsUpper ?? e.ts) >= window.from && (e.tsLower ?? e.ts) < window.to) {
        unplaced.set(e.srcSlot, (unplaced.get(e.srcSlot) ?? 0) + 1);
      }
      continue;
    }
    const prev = lastCheck.get(e.srcSlot);
    if (prev === undefined || e.ts > prev) lastCheck.set(e.srcSlot, e.ts);
    if (e.ts >= window.from && e.ts < window.to) list.push(e.ts);
  }

  return slots.map((slot) => {
    const times = bySlot.get(slot)!.sort((a, b) => a - b);
    const runs: ActivityRun[] = [];
    for (const t of times) {
      const cur = runs[runs.length - 1];
      if (cur && t - cur.to <= toleranceMs) {
        cur.to = t;
        cur.checks++;
      } else {
        runs.push({ from: t, to: t, checks: 1 });
      }
    }
    return {
      slot,
      runs,
      checks: times.length,
      unplaced: unplaced.get(slot) ?? 0,
      lastCheckAt: lastCheck.get(slot) ?? null,
    };
  });
}
