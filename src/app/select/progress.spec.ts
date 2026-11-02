import { EN, type Key } from '../i18n/en';
import { translate, type Dict, type Params } from '../i18n/translate';
import fr from '../../../public/i18n/fr.json';
import { describe, expect, it } from 'vitest';
import type { ApEvent, PresenceInterval, SlotStats } from '../db/db';
import { buildLanes, coverageGaps } from './lanes';
import {
  buildClassTotals,
  buildMultiworldItems,
  buildProgress,
  classSegments,
  countEvents,
} from './progress';

const tFr = (key: Key, params?: Params) => translate(key, params, 'fr', fr as Dict, EN);

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

function stats(slot: number, total: number, checked: number): SlotStats {
  return {
    roomId: 'seed',
    slot,
    totalLocations: total,
    checkedFromServer: checked,
    hintPoints: null,
    hintCostObserved: null,
    hintCostObservedFor: null,
    updatedAt: 0,
  };
}

const players = [
  { slot: 1, name: 'Alice', game: 'ALTTP' },
  { slot: 2, name: 'Bob', game: 'OOT' },
];

describe('countEvents', () => {
  it('compte les checks par emetteur et les objets par destinataire', () => {
    const c = countEvents([
      ev({ srcSlot: 1, dstSlot: 2 }),
      ev({ srcSlot: 1, dstSlot: 1 }),
      ev({ srcSlot: 2, dstSlot: 1 }),
      ev({ kind: 'chat', srcSlot: 1, dstSlot: null }),
    ]);
    expect(c.checksBySlot.get(1)).toBe(2);
    expect(c.checksBySlot.get(2)).toBe(1);
    expect(c.itemsReceivedBySlot.get(1)).toBe(2);
    expect(c.itemsReceivedBySlot.get(2)).toBe(1);
  });

  it('isole la part des checks a horodatage approximatif', () => {
    const c = countEvents([ev({ srcSlot: 1 }), ev({ srcSlot: 1, tsPrecision: 'approx' })]);
    expect(c.checksBySlot.get(1)).toBe(2);
    expect(c.approxChecksBySlot.get(1)).toBe(1);
  });
});

describe('buildClassTotals', () => {
  it('somme les ventilations par joueur sans doubler', () => {
    const t = buildClassTotals(
      countEvents([
        ev({ srcSlot: 1, dstSlot: 2, itemFlags: 1 }),
        ev({ srcSlot: 2, dstSlot: 1, itemFlags: 1 }),
        ev({ srcSlot: 2, dstSlot: 1, itemFlags: 2 }),
        ev({ srcSlot: 2, dstSlot: 1, itemFlags: 4 }),
        ev({ srcSlot: 2, dstSlot: 1, itemFlags: 0 }),
        ev({ srcSlot: null, dstSlot: 1, itemFlags: 1 }),
      ]),
    );
    expect(t.byClass.progression).toBe(3);
    expect(t.byClass.useful).toBe(1);
    expect(t.byClass.trap).toBe(1);
    expect(t.byClass.filler).toBe(1);
    expect(t.total).toBe(6);
  });

  it('range un drapeau absent en non resolu, et pas en banal', () => {
    const t = buildClassTotals(countEvents([ev({ srcSlot: 1, dstSlot: 2, itemFlags: null })]));
    expect(t.byClass.unknown).toBe(1);
    expect(t.byClass.filler).toBe(0);
    expect(t.total).toBe(1);
  });

  it('ne compte pas les checks, seulement les receptions', () => {
    const t = buildClassTotals(countEvents([ev({ srcSlot: 1, dstSlot: null, itemFlags: 1 })]));
    expect(t.total).toBe(0);
  });

  it('rend un total nul sans objet, plutot qu une division a venir', () => {
    expect(buildClassTotals(countEvents([])).total).toBe(0);
  });
});

describe('buildProgress', () => {
  it('donne un X/Y quand le total du slot est connu', () => {
    const counts = countEvents([ev({ srcSlot: 1 }), ev({ srcSlot: 1 })]);
    const [alice] = buildProgress(players, new Map([[1, stats(1, 10, 2)]]), counts);
    expect(alice).toMatchObject({ checked: 2, total: 10, ratio: 0.2 });
  });

  it('laisse le total a null pour un slot jamais interroge, sans l inventer', () => {
    const [, bob] = buildProgress(players, new Map(), countEvents([]));
    expect(bob.total).toBeNull();
    expect(bob.ratio).toBeNull();
  });

  it('retient le journal quand il a pris de l avance sur la derniere capture', () => {
    const counts = countEvents([ev({ srcSlot: 1 }), ev({ srcSlot: 1 }), ev({ srcSlot: 1 })]);
    const [alice] = buildProgress(players, new Map([[1, stats(1, 10, 2)]]), counts);
    expect(alice.checked).toBe(3);
  });

  it('borne le ratio a 1 meme si le journal deborde le total', () => {
    const counts = countEvents([ev({ srcSlot: 1 }), ev({ srcSlot: 1 })]);
    const [alice] = buildProgress(players, new Map([[1, stats(1, 1, 1)]]), counts);
    expect(alice.ratio).toBe(1);
  });

  it('ignore le plancher du serveur quand on relit un instant passe', () => {
    const counts = countEvents([ev({ srcSlot: 1 }), ev({ srcSlot: 1 })]);
    const stored = new Map([[1, stats(1, 10, 10)]]);

    const direct = buildProgress(players, stored, counts);
    expect(direct[0]).toMatchObject({ checked: 10, ratio: 1 });

    const relecture = buildProgress(players, stored, counts, { serverFloor: false });
    expect(relecture[0]).toMatchObject({ checked: 2, total: 10, ratio: 0.2 });
  });

  it('garde le total du serveur en relecture : il ne depend d aucun instant', () => {
    const counts = countEvents([ev({ srcSlot: 1 })]);
    const [alice] = buildProgress(players, new Map([[1, stats(1, 10, 10)]]), counts, {
      serverFloor: false,
    });
    expect(alice.total).toBe(10);
  });
});

describe('buildLanes', () => {
  const win = { from: 0, to: 100 * M };
  const intervals: PresenceInterval[] = [
    { roomId: 'seed', team: 0, slot: 1, from: 0, to: 10 * M, state: 'unknown', source: 'assumed' },
    { roomId: 'seed', team: 0, slot: 1, from: 10 * M, to: null, state: 'online', source: 'observed' },
    { roomId: 'seed', team: 0, slot: 2, from: -50 * M, to: 5 * M, state: 'offline', source: 'observed' },
  ];

  it('prolonge un intervalle ouvert jusqu au bout de la fenetre', () => {
    const [alice] = buildLanes(intervals, [1], win);
    expect(alice.segments[1]).toMatchObject({ from: 10 * M, to: 100 * M, state: 'online' });
  });

  it('decoupe a la fenetre ce qui deborde', () => {
    const [bob] = buildLanes(intervals, [2], win);
    expect(bob.segments[0]).toMatchObject({ from: 0, to: 5 * M });
  });

  it('rend une lane vide pour un slot sans intervalle, plutot que de la deviner', () => {
    const [none] = buildLanes(intervals, [9], win);
    expect(none.segments).toEqual([]);
  });
});

describe('coverageGaps', () => {
  it('expose les periodes ou l outil n ecoutait pas', () => {
    expect(coverageGaps([{ from: 10 * M, to: 20 * M }], { from: 0, to: 30 * M })).toEqual([
      { from: 0, to: 10 * M },
      { from: 20 * M, to: 30 * M },
    ]);
  });
});

describe('buildMultiworldItems', () => {
  const counts = countEvents([
    ev({ srcSlot: 1, dstSlot: 2, locationId: 10 }),
    ev({ srcSlot: 2, dstSlot: 1, locationId: 20 }),
    ev({ srcSlot: null, dstSlot: 1, locationId: null }),
  ]);

  it('compte les objets accordes hors location a part', () => {
    expect(counts.unplacedItems).toBe(1);
  });

  it('prend la somme des totaux de locations comme nombre d objets places', () => {
    const progress = buildProgress(players, new Map([[1, stats(1, 30, 1)], [2, stats(2, 70, 1)]]), counts);
    const mw = buildMultiworldItems(progress, counts);
    expect(mw.placed).toBe(100);
    expect(mw.found).toBe(2);
    expect(mw.ratio).toBeCloseTo(0.02);
    expect(mw.slotsUnknown).toBe(0);
    expect(mw.unplaced).toBe(1);
  });

  it('signale les slots au total inconnu et n en gonfle pas le ratio', () => {
    const progress = buildProgress(players, new Map([[1, stats(1, 30, 1)]]), counts);
    const mw = buildMultiworldItems(progress, counts);
    expect(mw.slotsUnknown).toBe(1);
    expect(mw.placed).toBe(30);
    expect(mw.found).toBe(2);
    expect(mw.foundInKnown).toBe(1);
    expect(mw.ratio).toBeCloseTo(1 / 30);
  });

  it('n invente pas de proportion quand aucun total n est connu', () => {
    const progress = buildProgress(players, new Map(), counts);
    expect(buildMultiworldItems(progress, counts).ratio).toBeNull();
  });
});

describe('classSegments', () => {
  it('ne rend que les classes presentes, et les pourcentages somment a 100', () => {
    const segs = classSegments({ progression: 3, useful: 1, filler: 0, trap: 0, unknown: 0 }, tFr);
    expect(segs.map((s) => s.key)).toEqual(['progression', 'useful']);
    expect(segs.reduce((n, s) => n + s.pct, 0)).toBeCloseTo(100);
    expect(segs[0].pct).toBeCloseTo(75);
  });

  it('compte les non resolus dans le denominateur et les nomme a part', () => {
    const segs = classSegments({ progression: 1, useful: 0, filler: 0, trap: 0, unknown: 1 }, tFr);
    expect(segs.map((s) => s.pct)).toEqual([50, 50]);
    expect(segs[1].title).toBe('non résolu : 1');
  });

  it('ne rend rien plutot qu une barre vide quand rien n a ete entendu', () => {
    expect(classSegments({ progression: 0, useful: 0, filler: 0, trap: 0, unknown: 0 }, tFr)).toEqual([]);
  });
});
