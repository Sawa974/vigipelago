import { describe, expect, it } from 'vitest';
import type { ApEvent } from '../db/db';
import { buildDeathTally } from './deaths';

let seq = 0;

function ev(over: Partial<ApEvent>): ApEvent {
  seq += 1;
  return {
    roomId: 'seed',
    ts: seq * 1000,
    tsPrecision: 'exact',
    tsLower: null,
    tsUpper: null,
    kind: 'death',
    team: 0,
    srcSlot: null,
    dstSlot: null,
    itemId: null,
    locationId: null,
    itemFlags: null,
    text: '',
    segments: [],
    tags: null,
    sessionId: 1,
    raw: null,
    dedupKey: `k${seq}`,
    ...over,
  };
}

/** Comme `onBounced` l'ecrit : la source n'est que dans `raw`. */
function death(over: Partial<ApEvent> & { source?: string } = {}): ApEvent {
  const { source, ...rest } = over;
  return ev({
    kind: 'death',
    raw: { cmd: 'Bounced', tags: ['DeathLink'], data: { source } },
    ...rest,
  });
}

function join(slot: number, tags: string[]): ApEvent {
  return ev({ kind: 'join', srcSlot: slot, tags });
}

describe('buildDeathTally', () => {
  it('compte les morts par slot et garde la derniere', () => {
    const t = buildDeathTally({
      events: [
        death({ srcSlot: 1, source: 'Alice', ts: 1000 }),
        death({ srcSlot: 1, source: 'Alice', ts: 5000 }),
        death({ srcSlot: 2, source: 'Bob', ts: 3000 }),
      ],
      slots: [1, 2],
    });
    expect(t.total).toBe(3);
    expect(t.bySlot.find((s) => s.slot === 1)).toMatchObject({
      count: 2,
      knowledge: 'observed',
      lastTs: 5000,
    });
    expect(t.bySlot.find((s) => s.slot === 2)?.count).toBe(1);
  });

  it('distingue un zero verifie d un zero ignore', () => {
    const t = buildDeathTally({
      events: [join(1, ['AP', 'DeathLink']), join(2, ['AP'])],
      slots: [1, 2, 3],
    });
    const s1 = t.bySlot.find((s) => s.slot === 1)!;
    const s2 = t.bySlot.find((s) => s.slot === 2)!;
    const s3 = t.bySlot.find((s) => s.slot === 3)!;

    expect(s1).toMatchObject({ count: 0, knowledge: 'tagged-silent' });
    expect(s2).toMatchObject({ count: null, knowledge: 'untagged' });
    expect(s3).toMatchObject({ count: null, knowledge: 'unknown' });

    expect(t.slotsWithoutData).toBe(2);
  });

  it('un tag retire plus tard remplace l annonce precedente', () => {
    const t = buildDeathTally({
      events: [join(1, ['DeathLink']), ev({ kind: 'tags', srcSlot: 1, tags: ['AP'] })],
      slots: [1],
    });
    expect(t.bySlot[0]).toMatchObject({ count: null, knowledge: 'untagged' });
  });

  it('garde les morts non attribuees dans le total global', () => {
    const t = buildDeathTally({
      events: [
        death({ srcSlot: 1, source: 'Alice' }),
        death({ srcSlot: null, source: 'Perso2' }),
        death({ srcSlot: null, source: 'Perso2' }),
      ],
      slots: [1],
    });
    expect(t.total).toBe(3);
    expect(t.unattributed).toBe(2);
    const sommeParJoueur = t.bySlot.reduce((n, s) => n + (s.count ?? 0), 0);
    expect(sommeParJoueur).toBe(1);
    expect(t.total).not.toBe(sommeParJoueur);
  });

  it('cite les sources distinctes, telles quelles', () => {
    const t = buildDeathTally({
      events: [
        death({ source: 'Zelda' }),
        death({ source: 'Alice' }),
        death({ source: 'Alice' }),
        death({ source: '' }),
      ],
      slots: [],
    });
    expect(t.sources).toEqual(['Alice', 'Zelda']);
  });

  it('garde les comptes quand une archive allegee a vide raw', () => {
    const t = buildDeathTally({
      events: [
        ev({ kind: 'death', srcSlot: 1, raw: null }),
        ev({ kind: 'death', srcSlot: 1, raw: null }),
        ev({ kind: 'death', srcSlot: null, raw: null }),
      ],
      slots: [1],
    });
    expect(t.total).toBe(3);
    expect(t.unattributed).toBe(1);
    expect(t.bySlot[0].count).toBe(2);
    expect(t.sources).toEqual([]);
  });

  it('donne la part de chacun sur les morts entendues, non attribuees comprises', () => {
    const t = buildDeathTally({
      events: [
        death({ srcSlot: 1, source: 'Alice' }),
        death({ srcSlot: 2, source: 'Bob' }),
        death({ srcSlot: 2, source: 'Bob' }),
        death({ srcSlot: null, source: 'Perso2' }),
        death({ srcSlot: null, source: 'Perso2' }),
      ],
      slots: [1, 2],
    });
    expect(t.bySlot.find((s) => s.slot === 1)?.share).toBe(0.2);
    expect(t.bySlot.find((s) => s.slot === 2)?.share).toBe(0.4);
    const sommeDesParts = t.bySlot.reduce((n, s) => n + (s.share ?? 0), 0);
    expect(sommeDesParts).toBeCloseTo(0.6);
  });

  it('ne donne aucune part a un slot dont on ne sait rien', () => {
    const t = buildDeathTally({
      events: [death({ srcSlot: 1, source: 'Alice' }), join(2, ['AP']), join(3, ['DeathLink'])],
      slots: [1, 2, 3],
    });
    expect(t.bySlot.find((s) => s.slot === 2)?.share).toBeNull();
    expect(t.bySlot.find((s) => s.slot === 3)?.share).toBe(0);
  });

  it('une room sans aucune mort se declare silencieuse', () => {
    const t = buildDeathTally({ events: [join(1, ['DeathLink'])], slots: [1] });
    expect(t.silent).toBe(true);
    expect(t.total).toBe(0);
  });

  it('ignore les evenements qui ne sont ni des morts ni des tags', () => {
    const t = buildDeathTally({
      events: [ev({ kind: 'item', srcSlot: 1 }), ev({ kind: 'chat', srcSlot: 1 })],
      slots: [1],
    });
    expect(t.total).toBe(0);
    expect(t.bySlot[0].knowledge).toBe('unknown');
  });
});

describe('les tags ne se lisent que sur un client de jeu', () => {
  it("n'attribue pas au joueur le tag DeathLink de notre propre connexion", () => {
    const t = buildDeathTally({
      events: [ev({ kind: 'join', srcSlot: 1, tags: ['TextOnly', 'Vigipelago', 'DeathLink'] })],
      slots: [1],
    });
    expect(t.bySlot[0]).toMatchObject({ count: null, knowledge: 'unknown' });
  });

  it("n'attribue pas au joueur le tag d'un tracker, qui ecoute sans jouer", () => {
    const t = buildDeathTally({
      events: [ev({ kind: 'join', srcSlot: 1, tags: ['Tracker', 'DeathLink'] })],
      slots: [1],
    });
    expect(t.bySlot[0]).toMatchObject({ knowledge: 'unknown' });
  });

  it('lit bien le tag quand il vient du client de jeu, avec ou sans autre tag', () => {
    const tagged = buildDeathTally({
      events: [ev({ kind: 'join', srcSlot: 1, tags: ['DeathLink'] })],
      slots: [1],
    });
    expect(tagged.bySlot[0]).toMatchObject({ count: 0, knowledge: 'tagged-silent' });
    const bare = buildDeathTally({ events: [ev({ kind: 'join', srcSlot: 1, tags: [] })], slots: [1] });
    expect(bare.bySlot[0]).toMatchObject({ count: null, knowledge: 'untagged' });
  });
});
