import type { PresenceInterval } from '../db/db';
import { gapsWithin, type Interval } from '../ingest/coverage';

export type LaneState = PresenceInterval['state'];

export interface LaneSegment {
  from: number;
  to: number;
  state: LaneState;
  source: PresenceInterval['source'];
}

export interface Lane {
  slot: number;
  segments: LaneSegment[];
}

export function buildLanes(
  intervals: readonly PresenceInterval[],
  slots: readonly number[],
  window: Interval,
): Lane[] {
  const bySlot = new Map<number, LaneSegment[]>();
  for (const s of slots) bySlot.set(s, []);

  for (const i of intervals) {
    const list = bySlot.get(i.slot);
    if (!list) continue;
    const from = Math.max(i.from, window.from);
    const to = Math.min(i.to ?? window.to, window.to);
    if (to <= from) continue;
    list.push({ from, to, state: i.state, source: i.source });
  }

  for (const list of bySlot.values()) list.sort((a, b) => a.from - b.from);
  return slots.map((slot) => ({ slot, segments: bySlot.get(slot)! }));
}

export function coverageGaps(coverage: Interval[], window: Interval): Interval[] {
  return gapsWithin(coverage, window.from, window.to);
}

// Pas de total des durees par etat : il se lirait comme un temps de jeu.
