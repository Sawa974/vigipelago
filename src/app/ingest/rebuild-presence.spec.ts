import { describe, expect, it } from 'vitest';
import { VIGIPELAGO_TAG } from '../protocol/tags';
import { replayPresence, type ReplayEvent } from './rebuild-presence';

const M = 60_000;

function join(ts: number, slot: number, tags: string[]): ReplayEvent {
  return { ts, kind: 'join', srcSlot: slot, tags };
}
function part(ts: number, slot: number): ReplayEvent {
  // Le protocole ne met aucun tag sur un Part.
  return { ts, kind: 'part', srcSlot: slot, tags: null };
}
function check(ts: number, slot: number): ReplayEvent {
  return { ts, kind: 'item', srcSlot: slot, tags: null };
}

function replay(events: ReplayEvent[], sessions = [{ startedAt: 0, endedAt: 100 * M, lastHeartbeatAt: 100 * M }]) {
  return replayPresence({ roomId: 'seed', team: 0, slots: [1], events, sessions });
}

function stateAt(intervals: ReturnType<typeof replay>, t: number): string | undefined {
  return intervals.find((i) => i.from <= t && (i.to ?? Infinity) > t)?.state;
}

describe('replayPresence', () => {
  it('reconstruit la sequence exacte du bug rapporte', () => {
    const intervals = replay([
      join(10 * M, 1, ['AP']),
      join(20 * M, 1, ['TextOnly', VIGIPELAGO_TAG]),
      part(21 * M, 1),
      check(30 * M, 1),
      check(40 * M, 1),
      part(60 * M, 1),
    ]);

    expect(stateAt(intervals, 5 * M)).toBe('unknown');
    expect(stateAt(intervals, 15 * M)).toBe('online');
    expect(stateAt(intervals, 25 * M)).toBe('online');
    expect(stateAt(intervals, 45 * M)).toBe('online');
    expect(stateAt(intervals, 70 * M)).toBe('offline');
  });

  it('apparie nos Part a nos Join, sans dependre du moment ou ils arrivent', () => {
    const intervals = replay([
      join(10 * M, 1, ['AP']),
      join(20 * M, 1, ['TextOnly', VIGIPELAGO_TAG]),
      part(50 * M, 1),
    ]);
    expect(stateAt(intervals, 60 * M)).toBe('online');
  });

  it('repart de zero a chaque session : entre elles, on ne savait rien', () => {
    const intervals = replayPresence({
      roomId: 'seed',
      team: 0,
      slots: [1],
      events: [join(5 * M, 1, ['AP'])],
      sessions: [
        { startedAt: 0, endedAt: 10 * M, lastHeartbeatAt: 10 * M },
        { startedAt: 50 * M, endedAt: 60 * M, lastHeartbeatAt: 60 * M },
      ],
    });
    expect(stateAt(intervals, 7 * M)).toBe('online');
    expect(stateAt(intervals, 55 * M)).toBe('unknown');
    expect(stateAt(intervals, 30 * M)).toBeUndefined();
  });

  it('borne une session jamais refermee a son dernier battement', () => {
    const intervals = replayPresence({
      roomId: 'seed',
      team: 0,
      slots: [1],
      events: [join(5 * M, 1, ['AP'])],
      sessions: [{ startedAt: 0, endedAt: null, lastHeartbeatAt: 20 * M }],
    });
    expect(stateAt(intervals, 19 * M)).toBe('online');
    expect(stateAt(intervals, 25 * M)).toBeUndefined();
  });

  it('produit un resultat identique a chaque rejeu', () => {
    const events = [join(10 * M, 1, ['AP']), check(20 * M, 1), part(30 * M, 1)];
    expect(replay(events)).toEqual(replay(events));
  });
});
