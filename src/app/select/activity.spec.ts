import { describe, expect, it } from 'vitest';
import type { ApEvent } from '../db/db';
import { activeDuration, buildActivity } from './activity';

const M = 60_000;
const WIN = { from: 0, to: 300 * M };

function check(ts: number, slot = 1, part: Partial<ApEvent> = {}): ApEvent {
  return {
    roomId: 'seed',
    ts,
    tsPrecision: 'exact',
    tsLower: null,
    tsUpper: null,
    kind: 'item',
    team: 0,
    srcSlot: slot,
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

describe('buildActivity', () => {
  it('regroupe en une plage les checks rapproches', () => {
    const [lane] = buildActivity([check(10 * M), check(15 * M), check(22 * M)], [1], WIN);
    expect(lane.runs).toEqual([{ from: 10 * M, to: 22 * M, checks: 3 }]);
  });

  it('coupe la plage au-dela de la tolerance', () => {
    const [lane] = buildActivity([check(10 * M), check(12 * M), check(90 * M)], [1], WIN);
    expect(lane.runs.map((r) => [r.from / M, r.to / M])).toEqual([
      [10, 12],
      [90, 90],
    ]);
  });

  it('n etend jamais une plage au-dela du dernier check', () => {
    const [lane] = buildActivity([check(10 * M)], [1], WIN);
    expect(lane.runs[0]).toEqual({ from: 10 * M, to: 10 * M, checks: 1 });
    expect(activeDuration(lane)).toBe(0);
  });

  it('ne place pas les checks rattrapes, mais les signale', () => {
    const approx = check(50 * M, 1, { tsPrecision: 'approx', tsLower: 20 * M, tsUpper: 80 * M });
    const [lane] = buildActivity([check(10 * M), approx], [1], WIN);
    expect(lane.runs).toHaveLength(1);
    expect(lane.checks).toBe(1);
    expect(lane.unplaced).toBe(1);
  });

  it('retient le dernier check meme anterieur a la fenetre', () => {
    const [lane] = buildActivity([check(-40 * M)], [1], { from: 0, to: 100 * M });
    expect(lane.runs).toEqual([]);
    expect(lane.lastCheckAt).toBe(-40 * M);
  });

  it('separe les joueurs et ignore ce qui n est pas un check', () => {
    const events = [check(10 * M, 1), check(11 * M, 2), check(12 * M, 1, { kind: 'chat' })];
    const lanes = buildActivity(events, [1, 2], WIN);
    expect(lanes[0].checks).toBe(1);
    expect(lanes[1].checks).toBe(1);
  });

  it('rend une lane vide pour un joueur sans aucun check', () => {
    const [lane] = buildActivity([], [7], WIN);
    expect(lane).toMatchObject({ slot: 7, runs: [], checks: 0, lastCheckAt: null });
  });
});
