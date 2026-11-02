import { describe, expect, it } from 'vitest';
import type { ApEvent, EventKind } from '../db/db';
import { goalInstants } from './goals';

const M = 60_000;

function line(ts: number, kind: EventKind, srcSlot: number | null): ApEvent {
  return {
    roomId: 'seed',
    ts,
    tsPrecision: 'exact',
    tsLower: null,
    tsUpper: null,
    kind,
    team: 0,
    srcSlot,
    dstSlot: null,
    itemId: null,
    locationId: null,
    itemFlags: null,
    text: '',
    segments: [],
    tags: null,
    sessionId: 1,
    raw: null,
    dedupKey: `x:${kind}:${ts}`,
  };
}

describe('goalInstants', () => {
  it('rend un instant par slot', () => {
    const map = goalInstants([line(30 * M, 'goal', 2), line(90 * M, 'goal', 3)]);
    expect([...map]).toEqual([
      [2, 30 * M],
      [3, 90 * M],
    ]);
  });

  it('garde le plus tot quand la meme annonce revient', () => {
    const map = goalInstants([line(90 * M, 'goal', 2), line(30 * M, 'goal', 2)]);
    expect(map.get(2)).toBe(30 * M);
  });

  it('ignore les lignes voisines du goal', () => {
    const map = goalInstants([
      line(10 * M, 'collect', 2),
      line(11 * M, 'release', 2),
      line(12 * M, 'item', 2),
    ]);
    expect(map.size).toBe(0);
  });

  it('ignore un goal qui ne s attribue a personne', () => {
    const map = goalInstants([line(30 * M, 'goal', null), line(40 * M, 'goal', 2)]);
    expect([...map]).toEqual([[2, 40 * M]]);
  });
});
