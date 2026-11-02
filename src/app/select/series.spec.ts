import { describe, expect, it } from 'vitest';
import type { ApEvent } from '../db/db';
import {
  bucketStarts,
  checksHistogram,
  chooseBucket,
  coveredFraction,
  cumulativeDeathsBySlot,
  cumulativeItemsBySlot,
} from './series';

const M = 60_000;

function ev(part: Partial<ApEvent>): ApEvent {
  return {
    roomId: 'seed',
    ts: 0,
    tsPrecision: 'exact',
    tsLower: null,
    tsUpper: null,
    kind: 'item',
    team: 0,
    srcSlot: 1,
    dstSlot: 2,
    itemId: 1,
    locationId: 1,
    itemFlags: 0,
    text: '',
    segments: [],
    tags: null,
    sessionId: 1,
    raw: null,
    dedupKey: Math.random().toString(36),
    ...part,
  };
}

describe('chooseBucket', () => {
  it('choisit un pas rond adapte a la duree', () => {
    expect(chooseBucket(30 * M)).toBe(M);
    expect(chooseBucket(24 * 60 * M)).toBe(30 * M);
  });
});

describe('coveredFraction', () => {
  it('mesure la part reellement ecoutee', () => {
    expect(coveredFraction([{ from: 0, to: 5 * M }], 0, 10 * M)).toBeCloseTo(0.5);
    expect(coveredFraction([], 0, 10 * M)).toBe(0);
    expect(coveredFraction([{ from: 0, to: 10 * M }], 2 * M, 4 * M)).toBe(1);
  });
});

describe('checksHistogram', () => {
  it('exclut les objets recus hors location du compte de rattrapes', () => {
    const w = { from: 0, to: 60 * M, bucketMs: 10 * M };
    const check = ev({ ts: 5 * M, tsPrecision: 'approx', tsLower: 0, tsUpper: 5 * M });
    const granted = ev({
      ts: 5 * M,
      tsPrecision: 'approx',
      tsLower: 0,
      tsUpper: 5 * M,
      srcSlot: null,
      locationId: null,
    });

    expect(checksHistogram([check, granted], w, []).unplaced).toBe(1);
  });

  const w = { from: 0, to: 10 * M, bucketMs: 5 * M };
  const cov = [{ from: 0, to: 10 * M }];

  it('range les checks horodates dans leur tranche', () => {
    const r = checksHistogram([ev({ ts: M }), ev({ ts: 2 * M }), ev({ ts: 7 * M })], w, cov);
    expect(r.buckets.map((b) => b.value)).toEqual([2, 1]);
    expect(r.max).toBe(2);
  });

  it('ne place pas les rattrapes, qui creeraient un pic artificiel', () => {
    const approx = ev({ ts: 3 * M, tsPrecision: 'approx', tsLower: 0, tsUpper: 6 * M });
    const r = checksHistogram([ev({ ts: M }), approx], w, cov);
    expect(r.buckets.map((b) => b.value)).toEqual([1, 0]);
    expect(r.unplaced).toBe(1);
  });

  it('signale la part non couverte de chaque tranche', () => {
    const r = checksHistogram([], w, [{ from: 0, to: 5 * M }]);
    expect(r.buckets[0].covered).toBe(1);
    expect(r.buckets[1].covered).toBe(0);
  });

  it('ventile chaque tranche par importance de l objet trouve', () => {
    const r = checksHistogram(
      [
        ev({ ts: M, itemFlags: 0b001 }),
        ev({ ts: 2 * M, itemFlags: 0b001 }),
        ev({ ts: 3 * M, itemFlags: 0b100 }),
        ev({ ts: 7 * M, itemFlags: 0 }),
      ],
      w,
      cov,
    );
    expect(r.buckets[0].byClass).toMatchObject({ progression: 2, trap: 1, filler: 0 });
    expect(r.buckets[1].byClass).toMatchObject({ filler: 1, progression: 0 });
    expect(r.placed).toBe(4);
  });

  it('range en non resolu un check dont le contenu n a pas ete retrouve', () => {
    const r = checksHistogram([ev({ ts: M, itemFlags: null })], w, cov);
    expect(r.buckets[0].byClass.unknown).toBe(1);
    expect(r.buckets[0].byClass.filler).toBe(0);
  });

  it('ignore les evenements qui ne sont pas des checks', () => {
    const r = checksHistogram([ev({ ts: M, kind: 'chat' })], w, cov);
    expect(r.buckets.map((b) => b.value)).toEqual([0, 0]);
  });
});

describe('cumulativeItemsBySlot', () => {
  const w = { from: 0, to: 20 * M, bucketMs: 5 * M };

  it('cumule les objets recus par destinataire', () => {
    const events = [
      ev({ ts: M, dstSlot: 2 }),
      ev({ ts: 6 * M, dstSlot: 2 }),
      ev({ ts: 7 * M, dstSlot: 3 }),
    ];
    const r = cumulativeItemsBySlot(events, [2, 3], w, [{ from: 0, to: 20 * M }]);
    expect(r.series[0].points).toEqual([1, 2, 2, 2]);
    expect(r.series[1].points).toEqual([0, 1, 1, 1]);
    expect(r.max).toBe(2);
  });

  it('rompt la courbe dans un trou plutot que de la prolonger a plat', () => {
    const cov = [
      { from: 0, to: 5 * M },
      { from: 15 * M, to: 20 * M },
    ];
    const r = cumulativeItemsBySlot([ev({ ts: M, dstSlot: 2 })], [2], w, cov);
    expect(r.series[0].points).toEqual([1, null, null, 1]);
  });

  it('compte un rattrape a sa borne haute, la ou on l a su', () => {
    const approx = ev({ ts: 3 * M, tsPrecision: 'approx', tsLower: 0, tsUpper: 16 * M, dstSlot: 2 });
    const r = cumulativeItemsBySlot([approx], [2], w, [{ from: 0, to: 20 * M }]);
    expect(r.series[0].points).toEqual([0, 0, 0, 1]);
  });

  it('reporte les objets anterieurs a la fenetre sur la premiere colonne', () => {
    const r = cumulativeItemsBySlot([ev({ ts: -5 * M, dstSlot: 2 })], [2], w, [{ from: -M, to: 20 * M }]);
    expect(r.series[0].points[0]).toBe(1);
  });

  it('donne des colonnes alignees sur le pas de temps', () => {
    expect(bucketStarts({ from: 2 * M, to: 12 * M, bucketMs: 5 * M })).toEqual([0, 5 * M, 10 * M]);
  });
});

describe('cumulativeDeathsBySlot', () => {
  const w = { from: 0, to: 20 * M, bucketMs: 5 * M };
  const cov = [{ from: 0, to: 20 * M }];

  it('cumule les morts sur leur slot d origine, et non sur un destinataire', () => {
    const events = [
      ev({ ts: M, kind: 'death', srcSlot: 2, dstSlot: null }),
      ev({ ts: 7 * M, kind: 'death', srcSlot: 2, dstSlot: null }),
      ev({ ts: 8 * M, kind: 'death', srcSlot: 3, dstSlot: null }),
    ];
    const r = cumulativeDeathsBySlot(events, [2, 3], w, cov);
    expect(r.series[0].points).toEqual([1, 2, 2, 2]);
    expect(r.series[1].points).toEqual([0, 1, 1, 1]);
    expect(r.max).toBe(2);
  });

  it('laisse de cote une mort sans source identifiable', () => {
    const r = cumulativeDeathsBySlot(
      [ev({ ts: M, kind: 'death', srcSlot: null, dstSlot: null })],
      [2],
      w,
      cov,
    );
    expect(r.series[0].points).toEqual([0, 0, 0, 0]);
    expect(r.max).toBe(0);
  });

  it('ne compte pas les objets comme des morts', () => {
    const r = cumulativeDeathsBySlot([ev({ ts: M, dstSlot: 2, srcSlot: 2 })], [2], w, cov);
    expect(r.series[0].last).toBe(0);
  });

  it('rompt la courbe dans une periode non ecoutee', () => {
    const r = cumulativeDeathsBySlot(
      [ev({ ts: M, kind: 'death', srcSlot: 2, dstSlot: null })],
      [2],
      w,
      [{ from: 0, to: 10 * M }],
    );
    expect(r.series[0].points).toEqual([1, 1, null, null]);
  });
});
