import { describe, expect, it } from 'vitest';
import type { ApEvent } from '../db/db';
import { matchesSearch, mergeSearchWithLive, normalizeQuery } from './feed-search';

function ev(part: Partial<ApEvent> & { text: string; ts: number }): ApEvent {
  return {
    roomId: 'Archipelago_1700000000',
    tsPrecision: 'exact',
    tsLower: null,
    tsUpper: null,
    kind: 'chat',
    team: 0,
    srcSlot: null,
    dstSlot: null,
    itemId: null,
    locationId: null,
    itemFlags: null,
    segments: [],
    tags: null,
    sessionId: 1,
    raw: null,
    dedupKey: `x:chat:${part.ts.toString(16)}:28333333`,
    ...part,
  };
}

describe('matchesSearch', () => {
  it('cherche sans tenir compte de la casse', () => {
    const q = normalizeQuery('  HINT  ');
    expect(q).toBe('hint');
    expect(matchesSearch(ev({ text: 'Dana a demande un Hint', ts: 1 }), q)).toBe(true);
    expect(matchesSearch(ev({ text: 'rien a voir', ts: 1 }), q)).toBe(false);
  });
});

describe('mergeSearchWithLive', () => {
  const base = [ev({ text: 'hint ancien', ts: 100 }), ev({ text: 'hint moins ancien', ts: 200 })];

  it('fait entrer une ligne vive arrivee apres la recherche', () => {
    const live = [ev({ text: 'hint tout neuf', ts: 300 })];
    expect(mergeSearchWithLive(base, live, 'hint').map((e) => e.text)).toEqual([
      'hint ancien',
      'hint moins ancien',
      'hint tout neuf',
    ]);
  });

  it('ignore une ligne vive qui ne correspond pas', () => {
    const live = [ev({ text: 'un objet quelconque', ts: 300 })];
    expect(mergeSearchWithLive(base, live, 'hint')).toHaveLength(2);
  });

  it('ne double pas une ligne presente dans les deux sources', () => {
    const live = [base[1], ev({ text: 'hint tout neuf', ts: 300 })];
    expect(mergeSearchWithLive(base, live, 'hint').map((e) => e.text)).toEqual([
      'hint ancien',
      'hint moins ancien',
      'hint tout neuf',
    ]);
  });

  it('insere une ligne vive plus ancienne a sa place, et non a la fin', () => {
    const live = [ev({ text: 'hint intercale', ts: 150 })];
    expect(mergeSearchWithLive(base, live, 'hint').map((e) => e.text)).toEqual([
      'hint ancien',
      'hint intercale',
      'hint moins ancien',
    ]);
  });

  it('garde l’ordre de la base a instant egal', () => {
    const live = [ev({ text: 'hint simultane', ts: 200, dedupKey: 'autre' })];
    expect(mergeSearchWithLive(base, live, 'hint').map((e) => e.text)).toEqual([
      'hint ancien',
      'hint moins ancien',
      'hint simultane',
    ]);
  });

  it('sans requete, ne touche a rien', () => {
    const live = [ev({ text: 'hint tout neuf', ts: 300 })];
    expect(mergeSearchWithLive(base, live, '')).toHaveLength(2);
  });

  it('un instantane vide se remplit quand meme', () => {
    const live = [ev({ text: 'hint tout neuf', ts: 300 })];
    expect(mergeSearchWithLive([], live, 'hint').map((e) => e.text)).toEqual(['hint tout neuf']);
  });
});
