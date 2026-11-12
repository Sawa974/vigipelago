import { describe, expect, it } from 'vitest';
import type { ApEvent } from '../db/db';
import { FEED_CATEGORIES, feedMatcher, isFilterActive, matchesFilter, type FeedCategory } from './feed-filter';

function ev(part: Partial<ApEvent>): ApEvent {
  return {
    roomId: 'Archipelago_1700000000',
    ts: 1,
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
    text: '',
    segments: [],
    tags: null,
    sessionId: 1,
    raw: null,
    dedupKey: 'k',
    ...part,
  };
}

const filter = (cats: FeedCategory[], slot: number | null = null) => ({ categories: new Set(cats), slot });

describe('isFilterActive', () => {
  it('rien de coche ne filtre pas', () => {
    expect(isFilterActive(filter([]))).toBe(false);
  });

  it('toutes les categories cochees ne filtrent pas, meme avec le slot', () => {
    expect(isFilterActive(filter([...FEED_CATEGORIES], 3))).toBe(false);
  });

  it('le slot seul filtre', () => {
    expect(isFilterActive(filter([], 3))).toBe(true);
  });
});

describe('matchesFilter', () => {
  it('range release et collect avec les objectifs', () => {
    const f = filter(['goals']);
    expect(matchesFilter(ev({ kind: 'release' }), f)).toBe(true);
    expect(matchesFilter(ev({ kind: 'collect' }), f)).toBe(true);
    expect(matchesFilter(ev({ kind: 'item' }), f)).toBe(false);
  });

  it('additionne les cases : tous les objets plus toutes les lignes du slot', () => {
    const f = filter(['items'], 2);
    expect(matchesFilter(ev({ kind: 'item', srcSlot: 5, dstSlot: 6 }), f)).toBe(true);
    expect(matchesFilter(ev({ kind: 'chat', srcSlot: 2 }), f)).toBe(true);
    expect(matchesFilter(ev({ kind: 'hint', srcSlot: 7, dstSlot: 2 }), f)).toBe(true);
    expect(matchesFilter(ev({ kind: 'chat', srcSlot: 5 }), f)).toBe(false);
  });

  it('une ligne sans slot ne passe que par sa categorie', () => {
    expect(matchesFilter(ev({ kind: 'server' }), filter([], 2))).toBe(false);
  });
});

describe('feedMatcher', () => {
  it('rend null sans texte ni case', () => {
    expect(feedMatcher('  ', filter([]))).toBeNull();
  });

  it('le texte et les cases se cumulent', () => {
    const m = feedMatcher('epee', filter(['items']))!;
    expect(m(ev({ kind: 'item', text: 'Une Epee' }))).toBe(true);
    expect(m(ev({ kind: 'chat', text: 'une epee' }))).toBe(false);
    expect(m(ev({ kind: 'item', text: 'un bouclier' }))).toBe(false);
  });
});
