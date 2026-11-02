/** Les cles `x:` contiennent la minute de reception : deux machines ne les partagent pas. */

import type { ApEvent, TsPrecision } from '../db/db';

export const OFFSET_DEADBAND_MS = 1_000;

export const MIN_OFFSET_SAMPLES = 5;

/** Apres correction du decalage. */
export const PAIR_WINDOW_MS = 120_000;

/** Le prefixe `{roomId}|` doit etre retire, sinon aucune cle ne parait stable. */
export function isStableKey(dedupKey: string): boolean {
  const suffix = dedupKey.slice(dedupKey.indexOf('|') + 1);
  return suffix.startsWith('i:') || suffix.startsWith('ri:');
}

export function volatileSignature(dedupKey: string): string {
  return dedupKey.slice(0, dedupKey.lastIndexOf(':'));
}

export interface LocalEventRef {
  id: number;
  dedupKey: string;
  ts: number;
  tsPrecision: TsPrecision;
  tsLower: number | null;
  tsUpper: number | null;
  itemId: number | null;
  itemFlags: number | null;
}

export type IncomingEvent = Omit<ApEvent, 'id' | 'sessionId'>;

export interface ClockOffset {
  /** `incoming.ts - local.ts`. 0 si non mesurable ou negligeable. */
  offsetMs: number;
  samples: number;
  reliable: boolean;
}

export function estimateClockOffset(
  localByKey: ReadonlyMap<string, LocalEventRef>,
  incoming: readonly IncomingEvent[],
): ClockOffset {
  const diffs: number[] = [];
  for (const e of incoming) {
    if (e.tsPrecision !== 'exact' || !isStableKey(e.dedupKey)) continue;
    const local = localByKey.get(e.dedupKey);
    if (!local || local.tsPrecision !== 'exact') continue;
    diffs.push(e.ts - local.ts);
  }

  if (diffs.length < MIN_OFFSET_SAMPLES) {
    return { offsetMs: 0, samples: diffs.length, reliable: false };
  }

  diffs.sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  const median = diffs.length % 2 === 1 ? diffs[mid] : Math.round((diffs[mid - 1] + diffs[mid]) / 2);
  const offsetMs = Math.abs(median) < OFFSET_DEADBAND_MS ? 0 : median;
  return { offsetMs, samples: diffs.length, reliable: true };
}

export interface EventCreate {
  event: IncomingEvent;
  srcSessionId: number;
}

export interface EventUpdate {
  id: number;
  changes: Partial<ApEvent>;
}

export interface MergeCounts {
  created: number;
  replaced: number;
  narrowed: number;
  known: number;
  paired: number;
  conflicts: number;
  classesResolved: number;
}

export interface MergePlan {
  creates: EventCreate[];
  updates: EventUpdate[];
  counts: MergeCounts;
}

export interface MergeInput {
  local: readonly LocalEventRef[];
  incoming: readonly { event: IncomingEvent; srcSessionId: number }[];
  offset: ClockOffset;
}

export function planMerge(input: MergeInput): MergePlan {
  const { offset } = input;
  const counts: MergeCounts = {
    created: 0,
    replaced: 0,
    narrowed: 0,
    known: 0,
    paired: 0,
    conflicts: 0,
    classesResolved: 0,
  };
  const creates: EventCreate[] = [];
  const updates: EventUpdate[] = [];

  const localByKey = new Map<string, LocalEventRef>();
  for (const e of input.local) localByKey.set(e.dedupKey, e);

  const volatilePool = new Map<string, { ts: number; used: boolean }[]>();
  for (const e of input.local) {
    if (isStableKey(e.dedupKey)) continue;
    const sig = volatileSignature(e.dedupKey);
    const bucket = volatilePool.get(sig);
    if (bucket) bucket.push({ ts: e.ts, used: false });
    else volatilePool.set(sig, [{ ts: e.ts, used: false }]);
  }

  // Deux exports concatenes : sans ce garde-fou, l'index unique ferait echouer l'import.
  const seen = new Set<string>();

  for (const { event, srcSessionId } of input.incoming) {
    if (seen.has(event.dedupKey)) {
      counts.known++;
      continue;
    }
    seen.add(event.dedupKey);

    const shifted = shiftEvent(event, offset.offsetMs);
    const local = localByKey.get(event.dedupKey);

    if (local) {
      const update = mergeExisting(local, shifted, counts);
      if (update) updates.push(update);
      continue;
    }

    if (!isStableKey(event.dedupKey)) {
      if (consumePair(volatilePool, volatileSignature(event.dedupKey), shifted.ts)) {
        counts.paired++;
        continue;
      }
    }

    creates.push({ event: shifted, srcSessionId });
    counts.created++;
  }

  return { creates, updates, counts };
}

/** Le `dedupKey` n'est pas recalcule : cela casserait l'appariement avec l'origine. */
function shiftEvent(event: IncomingEvent, offsetMs: number): IncomingEvent {
  if (offsetMs === 0) return event;
  return {
    ...event,
    ts: event.ts - offsetMs,
    tsLower: event.tsLower === null ? null : event.tsLower - offsetMs,
    tsUpper: event.tsUpper === null ? null : event.tsUpper - offsetMs,
  };
}

function mergeExisting(
  local: LocalEventRef,
  incoming: IncomingEvent,
  counts: MergeCounts,
): EventUpdate | null {
  if (local.tsPrecision === 'exact') {
    counts.known++;
    return enrich(local, incoming, counts, {});
  }

  if (incoming.tsPrecision === 'exact') {
    counts.replaced++;
    return {
      id: local.id,
      changes: {
        ts: incoming.ts,
        tsPrecision: 'exact',
        tsLower: null,
        tsUpper: null,
        itemId: incoming.itemId,
        itemFlags: incoming.itemFlags,
        text: incoming.text,
        segments: incoming.segments,
        raw: incoming.raw,
      },
    };
  }

  const lower = Math.max(local.tsLower ?? -Infinity, incoming.tsLower ?? -Infinity);
  const upper = Math.min(local.tsUpper ?? Infinity, incoming.tsUpper ?? Infinity);

  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) {
    counts.conflicts++;
    return enrich(local, incoming, counts, {});
  }

  const narrower = lower > (local.tsLower ?? -Infinity) || upper < (local.tsUpper ?? Infinity);
  if (!narrower) {
    counts.known++;
    return enrich(local, incoming, counts, {});
  }

  counts.narrowed++;
  return enrich(local, incoming, counts, {
    tsLower: lower,
    tsUpper: upper,
    ts: Math.round((lower + upper) / 2),
  });
}

/** Ne remplace jamais une valeur connue. */
function enrich(
  local: LocalEventRef,
  incoming: IncomingEvent,
  counts: MergeCounts,
  changes: Partial<ApEvent>,
): EventUpdate | null {
  const out: Partial<ApEvent> = { ...changes };
  if (local.itemId === null && incoming.itemId !== null) out.itemId = incoming.itemId;
  if (local.itemFlags === null && incoming.itemFlags !== null) {
    out.itemFlags = incoming.itemFlags;
    counts.classesResolved++;
  }
  return Object.keys(out).length > 0 ? { id: local.id, changes: out } : null;
}

/** Un pour un : un message reellement ecrit deux fois garde deux lignes. */
function consumePair(
  pool: Map<string, { ts: number; used: boolean }[]>,
  signature: string,
  ts: number,
): boolean {
  const bucket = pool.get(signature);
  if (!bucket) return false;

  let best: { ts: number; used: boolean } | null = null;
  let bestDelta = Infinity;
  for (const candidate of bucket) {
    if (candidate.used) continue;
    const delta = Math.abs(candidate.ts - ts);
    if (delta <= PAIR_WINDOW_MS && delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }

  if (best === null) return false;
  best.used = true;
  return true;
}

/** Les ids sont des auto-increments locaux : l'identite vient du contenu. */
export function sessionIdentity(s: {
  roomId: string;
  startedAt: number;
  connectedAsSlot: string;
}): string {
  return `${s.roomId}|${s.startedAt}|${s.connectedAsSlot}`;
}

export function snapshotIdentity(s: { roomId: string; slot: number; ts: number }): string {
  return `${s.roomId}|${s.slot}|${s.ts}`;
}
