import { describe, expect, it } from 'vitest';
import type { ApEvent } from '../db/db';
import {
  estimateClockOffset,
  isStableKey,
  MIN_OFFSET_SAMPLES,
  PAIR_WINDOW_MS,
  planMerge,
  sessionIdentity,
  volatileSignature,
  type ClockOffset,
  type IncomingEvent,
  type LocalEventRef,
} from './merge';

const M = 60_000;
const S = 1_000;

const ALIGNED: ClockOffset = { offsetMs: 0, samples: 20, reliable: true };

function local(over: Partial<LocalEventRef> = {}): LocalEventRef {
  return {
    id: 1,
    dedupKey: 'i:0:3:1204',
    ts: 10 * M,
    tsPrecision: 'exact',
    tsLower: null,
    tsUpper: null,
    itemId: 77,
    itemFlags: 1,
    ...over,
  };
}

function incoming(over: Partial<IncomingEvent> = {}): IncomingEvent {
  return {
    roomId: 'Seed42',
    ts: 10 * M,
    tsPrecision: 'exact',
    tsLower: null,
    tsUpper: null,
    kind: 'item',
    team: 0,
    srcSlot: 3,
    dstSlot: 4,
    itemId: 77,
    locationId: 1204,
    itemFlags: 1,
    text: 'Truc',
    segments: [{ text: 'Truc', cls: 'item' }],
    tags: null,
    raw: null,
    dedupKey: 'i:0:3:1204',
    ...over,
  } as IncomingEvent;
}

function plan(locals: LocalEventRef[], incs: IncomingEvent[], offset: ClockOffset = ALIGNED) {
  return planMerge({
    local: locals,
    incoming: incs.map((event) => ({ event, srcSessionId: 1 })),
    offset,
  });
}

describe('classification des cles', () => {
  it('reconnait les cles stables entre deux machines', () => {
    expect(isStableKey('i:0:3:1204')).toBe(true);
    expect(isStableKey('ri:0:2:15')).toBe(true);
  });

  it('classe la cle x comme volatile : elle porte la minute de reception', () => {
    expect(isStableKey('x:chat:9f2a:29051')).toBe(false);
  });

  it('retire la minute pour obtenir la signature d appariement', () => {
    expect(volatileSignature('x:chat:9f2a:29051')).toBe('x:chat:9f2a');
  });
});

describe('estimateClockOffset', () => {
  it('mesure le decalage sur la mediane des evenements communs', () => {
    const locals: LocalEventRef[] = [];
    const incs: IncomingEvent[] = [];
    for (let i = 0; i < 7; i++) {
      const key = `i:0:3:${i}`;
      locals.push(local({ id: i + 1, dedupKey: key, ts: 10 * M + i * S }));
      // L'autre machine avance de 5 s, avec un peu de gigue.
      incs.push(incoming({ dedupKey: key, ts: 10 * M + i * S + 5 * S + (i % 3) - 1 }));
    }
    const off = estimateClockOffset(new Map(locals.map((l) => [l.dedupKey, l])), incs);
    expect(off.reliable).toBe(true);
    expect(off.samples).toBe(7);
    expect(off.offsetMs).toBeCloseTo(5 * S, -2);
  });

  it('resiste a une valeur aberrante grace a la mediane', () => {
    const locals: LocalEventRef[] = [];
    const incs: IncomingEvent[] = [];
    for (let i = 0; i < 9; i++) {
      const key = `i:0:3:${i}`;
      locals.push(local({ id: i + 1, dedupKey: key, ts: 10 * M }));
      incs.push(incoming({ dedupKey: key, ts: 10 * M + 3 * S }));
    }
    incs[0] = incoming({ dedupKey: 'i:0:3:0', ts: 10 * M + 4 * 3600 * S });
    const off = estimateClockOffset(new Map(locals.map((l) => [l.dedupKey, l])), incs);
    expect(off.offsetMs).toBe(3 * S);
  });

  it('refuse de conclure sous le seuil d echantillons', () => {
    const locals = [local({ dedupKey: 'i:0:3:1' })];
    const off = estimateClockOffset(
      new Map(locals.map((l) => [l.dedupKey, l])),
      [incoming({ dedupKey: 'i:0:3:1', ts: 10 * M + 30 * S })],
    );
    expect(off.reliable).toBe(false);
    expect(off.offsetMs).toBe(0);
    expect(off.samples).toBeLessThan(MIN_OFFSET_SAMPLES);
  });

  it('ignore les approx : un milieu d intervalle ne mesure pas une horloge', () => {
    const locals: LocalEventRef[] = [];
    const incs: IncomingEvent[] = [];
    for (let i = 0; i < 8; i++) {
      const key = `i:0:3:${i}`;
      locals.push(
        local({ id: i + 1, dedupKey: key, ts: 10 * M, tsPrecision: 'approx', tsLower: 0, tsUpper: 20 * M }),
      );
      incs.push(incoming({ dedupKey: key, ts: 12 * M }));
    }
    expect(estimateClockOffset(new Map(locals.map((l) => [l.dedupKey, l])), incs).reliable).toBe(false);
  });

  it('neglige un ecart inferieur a la zone morte', () => {
    const locals: LocalEventRef[] = [];
    const incs: IncomingEvent[] = [];
    for (let i = 0; i < 6; i++) {
      const key = `i:0:3:${i}`;
      locals.push(local({ id: i + 1, dedupKey: key, ts: 10 * M }));
      incs.push(incoming({ dedupKey: key, ts: 10 * M + 200 }));
    }
    expect(estimateClockOffset(new Map(locals.map((l) => [l.dedupKey, l])), incs).offsetMs).toBe(0);
  });
});

describe('planMerge — la regle dictee : une seule ligne par evenement', () => {
  it('cree ce qui manque', () => {
    const p = plan([], [incoming({ dedupKey: 'i:0:3:99' })]);
    expect(p.counts.created).toBe(1);
    expect(p.creates[0].event.dedupKey).toBe('i:0:3:99');
    expect(p.updates).toHaveLength(0);
  });

  it('garde la notre quand elle est exacte, meme si l autre l est aussi', () => {
    const p = plan([local()], [incoming({ ts: 10 * M + 400 })]);
    expect(p.counts.known).toBe(1);
    expect(p.counts.replaced).toBe(0);
    expect(p.creates).toHaveLength(0);
    expect(p.updates).toHaveLength(0);
  });

  it('ecrase notre approx par son exact, contenu compris', () => {
    const mine = local({ tsPrecision: 'approx', ts: 15 * M, tsLower: 10 * M, tsUpper: 20 * M, itemFlags: null });
    const p = plan([mine], [incoming({ ts: 17 * M, itemFlags: 4, text: 'Piege' })]);
    expect(p.counts.replaced).toBe(1);
    expect(p.updates[0]).toMatchObject({
      id: 1,
      changes: { ts: 17 * M, tsPrecision: 'exact', tsLower: null, tsUpper: null, itemFlags: 4, text: 'Piege' },
    });
  });

  it('resserre les bornes quand les deux sont approximatives', () => {
    const mine = local({ tsPrecision: 'approx', ts: 15 * M, tsLower: 10 * M, tsUpper: 20 * M });
    const his = incoming({ tsPrecision: 'approx', ts: 16 * M, tsLower: 12 * M, tsUpper: 18 * M });
    const p = plan([mine], [his]);
    expect(p.counts.narrowed).toBe(1);
    expect(p.updates[0].changes).toMatchObject({ tsLower: 12 * M, tsUpper: 18 * M, ts: 15 * M });
  });

  it('ne fait rien quand ses bornes sont plus larges que les notres', () => {
    const mine = local({ tsPrecision: 'approx', ts: 15 * M, tsLower: 14 * M, tsUpper: 16 * M });
    const his = incoming({ tsPrecision: 'approx', ts: 15 * M, tsLower: 10 * M, tsUpper: 20 * M });
    const p = plan([mine], [his]);
    expect(p.counts.known).toBe(1);
    expect(p.counts.narrowed).toBe(0);
  });

  it('ne tranche pas des bornes disjointes, et le signale', () => {
    const mine = local({ tsPrecision: 'approx', ts: 15 * M, tsLower: 10 * M, tsUpper: 20 * M });
    const his = incoming({ tsPrecision: 'approx', ts: 40 * M, tsLower: 30 * M, tsUpper: 50 * M });
    const p = plan([mine], [his]);
    expect(p.counts.conflicts).toBe(1);
    expect(p.counts.narrowed).toBe(0);
    expect(p.creates).toHaveLength(0);
  });

  it('renseigne une classe d objet que notre ligne rattrapee ignorait', () => {
    const mine = local({ itemFlags: null, itemId: null, tsPrecision: 'approx', tsLower: 0, tsUpper: 20 * M });
    const his = incoming({ tsPrecision: 'approx', tsLower: 0, tsUpper: 20 * M, itemFlags: 1, itemId: 77 });
    const p = plan([mine], [his]);
    expect(p.counts.classesResolved).toBe(1);
    expect(p.updates[0].changes).toMatchObject({ itemFlags: 1, itemId: 77 });
  });

  it('n ecrase jamais une classe deja connue', () => {
    const p = plan([local({ itemFlags: 1 })], [incoming({ itemFlags: 4 })]);
    expect(p.counts.classesResolved).toBe(0);
    expect(p.updates).toHaveLength(0);
  });
});

describe('planMerge — cles volatiles, le vrai risque de doublon', () => {
  const chat = (minute: number, ts: number) =>
    incoming({ kind: 'chat', dedupKey: `x:chat:9f2a:${minute}`, ts, srcSlot: 2, locationId: null, itemId: null, itemFlags: null });

  it('apparie le meme message malgre une minute de cle differente', () => {
    const mine = local({ id: 5, dedupKey: 'x:chat:9f2a:29050', ts: 29050 * M + 59 * S, itemId: null, itemFlags: null });
    const p = plan([mine], [chat(29051, 29051 * M + 1 * S)]);
    expect(p.counts.paired).toBe(1);
    expect(p.counts.created).toBe(0);
    expect(p.creates).toHaveLength(0);
  });

  it('cree le message quand il est hors fenetre : ce n est pas le meme', () => {
    const mine = local({ id: 5, dedupKey: 'x:chat:9f2a:29050', ts: 29050 * M, itemId: null, itemFlags: null });
    const p = plan([mine], [chat(29060, 29050 * M + PAIR_WINDOW_MS + 1)]);
    expect(p.counts.created).toBe(1);
    expect(p.counts.paired).toBe(0);
  });

  it('apparie un pour un : deux copies locales et trois importees font trois, pas cinq', () => {
    const mine = [
      local({ id: 5, dedupKey: 'x:chat:9f2a:100', ts: 100 * M, itemId: null, itemFlags: null }),
      local({ id: 6, dedupKey: 'x:chat:9f2a:101', ts: 101 * M, itemId: null, itemFlags: null }),
    ];
    const his = [chat(200, 100 * M + S), chat(201, 101 * M + S), chat(500, 500 * M)];
    const p = plan(mine, his);
    expect(p.counts.paired).toBe(2);
    expect(p.counts.created).toBe(1);
    expect(p.creates[0].event.ts).toBe(500 * M);
  });

  it('une cle volatile identique reste une simple collision de cle', () => {
    const mine = local({ id: 5, dedupKey: 'x:chat:9f2a:100', ts: 100 * M, itemId: null, itemFlags: null });
    const p = plan([mine], [chat(100, 100 * M)]);
    expect(p.counts.known).toBe(1);
    expect(p.counts.created).toBe(0);
  });

  it('applique le decalage d horloge avant d apparier', () => {
    const mine = local({ id: 5, dedupKey: 'x:chat:9f2a:100', ts: 100 * M, itemId: null, itemFlags: null });
    // Sans correction, le message serait hors fenetre.
    const his = chat(110, 110 * M);
    const decale: ClockOffset = { offsetMs: 10 * M, samples: 20, reliable: true };
    expect(plan([mine], [his], decale).counts.paired).toBe(1);
    expect(plan([mine], [his], ALIGNED).counts.created).toBe(1);
  });

  it('replace un evenement cree a l heure de notre horloge', () => {
    const decale: ClockOffset = { offsetMs: 90 * S, samples: 20, reliable: true };
    const p = plan([], [chat(100, 100 * M)], decale);
    expect(p.creates[0].event.ts).toBe(100 * M - 90 * S);
    expect(p.creates[0].event.dedupKey).toBe('x:chat:9f2a:100');
  });

  it('deplace les trois horodatages d un approx sans deformer l intervalle', () => {
    const decale: ClockOffset = { offsetMs: 60 * S, samples: 20, reliable: true };
    const his = incoming({
      dedupKey: 'i:0:3:500',
      tsPrecision: 'approx',
      ts: 15 * M,
      tsLower: 10 * M,
      tsUpper: 20 * M,
    });
    const created = plan([], [his], decale).creates[0].event;
    expect(created.ts).toBe(15 * M - 60 * S);
    expect(created.tsLower).toBe(10 * M - 60 * S);
    expect(created.tsUpper).toBe(20 * M - 60 * S);
    expect(created.tsUpper! - created.tsLower!).toBe(10 * M);
  });
});

describe('planMerge — idempotence', () => {
  it('un second passage du meme lot ne cree plus rien', () => {
    const incs = [
      incoming({ dedupKey: 'i:0:3:1' }),
      incoming({ dedupKey: 'x:chat:aa:100', kind: 'chat', ts: 100 * M, itemId: null, itemFlags: null }),
    ];
    const first = plan([], incs);
    expect(first.counts.created).toBe(2);

    const after: LocalEventRef[] = first.creates.map((c, i) => ({
      id: i + 1,
      dedupKey: c.event.dedupKey,
      ts: c.event.ts,
      tsPrecision: c.event.tsPrecision,
      tsLower: c.event.tsLower,
      tsUpper: c.event.tsUpper,
      itemId: c.event.itemId,
      itemFlags: c.event.itemFlags,
    }));

    const second = plan(after, incs);
    expect(second.counts.created).toBe(0);
    expect(second.creates).toHaveLength(0);
    expect(second.updates).toHaveLength(0);
  });
});

describe('planMerge — fichier mal forme', () => {
  it('ignore une cle repetee dans le meme lot, comme deux exports concatenes', () => {
    const twice = [incoming({ dedupKey: 'i:0:3:7' }), incoming({ dedupKey: 'i:0:3:7' })];
    const p = plan([], twice);
    expect(p.counts.created).toBe(1);
    expect(p.counts.known).toBe(1);
    expect(p.creates).toHaveLength(1);
  });
});

describe('sessionIdentity', () => {
  it('derive l identite du contenu, jamais de l id auto-incremente', () => {
    const a = { roomId: 'Seed42', startedAt: 10 * M, connectedAsSlot: 'Ada' };
    expect(sessionIdentity(a)).toBe(sessionIdentity({ ...a }));
    expect(sessionIdentity(a)).not.toBe(sessionIdentity({ ...a, startedAt: 11 * M }));
    expect(sessionIdentity(a)).not.toBe(sessionIdentity({ ...a, connectedAsSlot: 'Bryn' }));
  });
});

/** Les cles reelles sont prefixees par la roomId, contrairement aux fixtures ci-dessus. */
describe('cles reelles prefixees par la roomId', () => {
  const R = '53474563874335540287';

  it('reconnait la cle stable malgre le prefixe de room', () => {
    expect(isStableKey(`${R}|i:0:3:1204`)).toBe(true);
    expect(isStableKey(`${R}|ri:0:2:15`)).toBe(true);
    expect(isStableKey(`${R}|x:chat:9f2a:29051`)).toBe(false);
  });

  it('mesure le decalage d horloge sur des cles prefixees', () => {
    const locals: LocalEventRef[] = [];
    const incs: IncomingEvent[] = [];
    for (let i = 0; i < MIN_OFFSET_SAMPLES + 2; i++) {
      const key = `${R}|i:0:3:${i}`;
      locals.push(local({ id: i + 1, dedupKey: key, ts: 10 * M + i * S }));
      incs.push(incoming({ dedupKey: key, ts: 10 * M + i * S + 5 * S }));
    }
    const off = estimateClockOffset(new Map(locals.map((l) => [l.dedupKey, l])), incs);
    expect(off.samples).toBe(MIN_OFFSET_SAMPLES + 2);
    expect(off.reliable).toBe(true);
    expect(off.offsetMs).toBe(5 * S);
  });

  it('n avale pas un check absent parce qu un autre check du meme slot est proche', () => {
    const mine = local({ id: 1, dedupKey: `${R}|i:0:3:100`, ts: 10 * M });
    const theirs = incoming({ dedupKey: `${R}|i:0:3:101`, ts: 10 * M + 30 * S });
    const p = plan([mine], [theirs]);
    expect(p.counts.paired).toBe(0);
    expect(p.counts.created).toBe(1);
    expect(p.creates[0].event.dedupKey).toBe(`${R}|i:0:3:101`);
  });

  it('apparie toujours un vrai doublon de message a cle volatile, prefixe compris', () => {
    const mine = local({ id: 1, dedupKey: `${R}|x:chat:9f2a:29051`, ts: 10 * M });
    const theirs = incoming({ dedupKey: `${R}|x:chat:9f2a:29052`, ts: 10 * M + 30 * S });
    const p = plan([mine], [theirs]);
    expect(p.counts.paired).toBe(1);
    expect(p.counts.created).toBe(0);
  });
});
