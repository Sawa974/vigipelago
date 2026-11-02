import type { NetworkSlot } from '../protocol/types';
import { gapDuration, type Interval } from './coverage';

// Chaque connexion du balayage emet un Join et un Part visibles de toute la room.

export const SWEEP_GAP_THRESHOLD_MS = 60_000;

export interface SweepDecision {
  sweep: boolean;
  reason: 'jamais-balaye' | 'trou-detecte' | 'couverture-continue' | 'desactive';
  gapMs: number;
}

export function decideSweep(
  coverage: Interval[],
  lastSweepAt: number | null,
  now: number,
  enabled: boolean,
  thresholdMs: number = SWEEP_GAP_THRESHOLD_MS,
): SweepDecision {
  if (!enabled) return { sweep: false, reason: 'desactive', gapMs: 0 };
  if (lastSweepAt === null) return { sweep: true, reason: 'jamais-balaye', gapMs: 0 };
  const gapMs = gapDuration(coverage, lastSweepAt, now);
  return gapMs >= thresholdMs
    ? { sweep: true, reason: 'trou-detecte', gapMs }
    : { sweep: false, reason: 'couverture-continue', gapMs };
}

export interface SweepTarget {
  slot: number;
  name: string;
}

const SLOT_TYPE_PLAYER = 1;

/** Sans les groupes, qui ne sont pas connectables. */
export function selectSweepTargets(
  slotInfo: Record<string, NetworkSlot>,
  ownSlot: number | null,
): SweepTarget[] {
  return Object.entries(slotInfo)
    .map(([slot, info]) => ({ slot: Number(slot), info }))
    .filter(({ slot, info }) => info.type === SLOT_TYPE_PLAYER && slot !== ownSlot)
    .map(({ slot, info }) => ({ slot, name: info.name }))
    .sort((a, b) => a.slot - b.slot);
}
