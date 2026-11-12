import type { ApEvent } from '../db/db';
import { gapsWithin, type Interval } from '../ingest/coverage';
import { itemClassOf, type ItemClass } from '../protocol/item-class';

// Pas d'interpolation a travers un trou ; un rattrape sort de l'histogramme, cumule a `tsUpper`.

export interface TimeWindow {
  from: number;
  to: number;
  bucketMs: number;
  /** Decalage du fuseau : sans lui, une tranche de 24 h commence a minuit UTC, pas a minuit local. */
  offsetMs?: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NICE_BUCKETS = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR];

export function chooseBucket(spanMs: number, target = 60): number {
  for (const b of NICE_BUCKETS) {
    if (spanMs / b <= target) return b;
  }
  return NICE_BUCKETS[NICE_BUCKETS.length - 1];
}

function bucketStart(ts: number, w: TimeWindow): number {
  const off = w.offsetMs ?? 0;
  return Math.floor((ts + off) / w.bucketMs) * w.bucketMs - off;
}

export function bucketStarts(w: TimeWindow): number[] {
  const first = bucketStart(w.from, w);
  const out: number[] = [];
  for (let t = first; t < w.to; t += w.bucketMs) out.push(t);
  return out;
}

export function coveredFraction(coverage: Interval[], from: number, to: number): number {
  const span = to - from;
  if (span <= 0) return 1;
  const gap = gapsWithin(coverage, from, to).reduce((sum, g) => sum + (g.to - g.from), 0);
  return 1 - gap / span;
}

export type BucketTally = Record<ItemClass | 'unknown', number>;

export interface HistogramBucket {
  t: number;
  value: number;
  byClass: BucketTally;
  /** Sous 1, le compte est un minorant. */
  covered: number;
}

export interface HistogramResult {
  buckets: HistogramBucket[];
  placed: number;
  unplaced: number;
  max: number;
}

function emptyTally(): BucketTally {
  return { progression: 0, useful: 0, filler: 0, trap: 0, unknown: 0 };
}

export function checksHistogram(
  events: readonly ApEvent[],
  w: TimeWindow,
  coverage: Interval[],
): HistogramResult {
  const starts = bucketStarts(w);
  const index = new Map<number, number>();
  starts.forEach((t, i) => index.set(t, i));
  const values = new Array<number>(starts.length).fill(0);
  const tallies = starts.map(() => emptyTally());
  let unplaced = 0;
  let placed = 0;

  for (const e of events) {
    // Meme predicat de check que `countEvents` et `activityLanes`.
    if (e.kind !== 'item' || e.srcSlot === null) continue;
    if (e.ts < w.from || e.ts >= w.to) {
      if (e.tsPrecision === 'approx' && overlapsWindow(e, w)) unplaced++;
      continue;
    }
    if (e.tsPrecision === 'approx') {
      unplaced++;
      continue;
    }
    const i = index.get(bucketStart(e.ts, w));
    if (i !== undefined) {
      values[i]++;
      placed++;
      tallies[i][itemClassOf(e.itemFlags) ?? 'unknown']++;
    }
  }

  const buckets = starts.map((t, i) => ({
    t,
    value: values[i],
    byClass: tallies[i],
    covered: coveredFraction(coverage, t, Math.min(t + w.bucketMs, w.to)),
  }));
  return { buckets, placed, unplaced, max: Math.max(0, ...values) };
}

function overlapsWindow(e: ApEvent, w: TimeWindow): boolean {
  const lo = e.tsLower ?? -Infinity;
  const hi = e.tsUpper ?? e.ts;
  return hi >= w.from && lo < w.to;
}

export interface SlotSeries {
  slot: number;
  /** `null` dans un trou de donnees, pour rompre la courbe. */
  points: (number | null)[];
  last: number;
}

export interface CumulativeResult {
  starts: number[];
  series: SlotSeries[];
  max: number;
}

/** Une ligne sans slot est perdue ici : la somme des courbes peut etre sous le total global. */
function cumulativeBySlot(
  events: readonly ApEvent[],
  slots: readonly number[],
  w: TimeWindow,
  coverage: Interval[],
  credit: (e: ApEvent) => number | null,
): CumulativeResult {
  const starts = bucketStarts(w);
  const wanted = new Set(slots);
  const perSlot = new Map<number, number[]>();
  for (const s of slots) perSlot.set(s, new Array<number>(starts.length).fill(0));

  for (const e of events) {
    const slot = credit(e);
    if (slot === null || !wanted.has(slot)) continue;
    const at = e.tsPrecision === 'approx' ? (e.tsUpper ?? e.ts) : e.ts;
    if (at >= w.to) continue;
    const i = at < w.from ? 0 : Math.round((bucketStart(at, w) - starts[0]) / w.bucketMs);
    const arr = perSlot.get(slot)!;
    if (i >= 0 && i < arr.length) arr[i]++;
  }

  // Un bucket non couvert vaut `null`, pas zero.
  const blank = starts.map((t) => coveredFraction(coverage, t, Math.min(t + w.bucketMs, w.to)) === 0);

  let max = 0;
  const series: SlotSeries[] = slots.map((slot) => {
    const inc = perSlot.get(slot)!;
    let running = 0;
    const points = inc.map((n, i) => {
      running += n;
      if (running > max) max = running;
      return blank[i] ? null : running;
    });
    return { slot, points, last: running };
  });

  return { starts, series, max };
}

export function cumulativeItemsBySlot(
  events: readonly ApEvent[],
  slots: readonly number[],
  w: TimeWindow,
  coverage: Interval[],
): CumulativeResult {
  return cumulativeBySlot(events, slots, w, coverage, (e) =>
    e.kind === 'item' ? e.dstSlot : null,
  );
}

/** Une mort ne se rattrape jamais : la courbe qui reprend apres un trou a perdu des marches. */
export function cumulativeDeathsBySlot(
  events: readonly ApEvent[],
  slots: readonly number[],
  w: TimeWindow,
  coverage: Interval[],
): CumulativeResult {
  return cumulativeBySlot(events, slots, w, coverage, (e) =>
    e.kind === 'death' ? e.srcSlot : null,
  );
}
