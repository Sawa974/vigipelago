import { describe, expect, it } from 'vitest';
import { toolChatterKeys, type ChatterEvent } from './tool-chatter';

let seq = 0;

function ev(part: Partial<ChatterEvent>): ChatterEvent {
  return {
    kind: 'join',
    srcSlot: 1,
    tags: null,
    sessionId: 1,
    dedupKey: `k${seq++}`,
    ...part,
  };
}

const OURS = ['TextOnly', 'Vigipelago'];

describe('toolChatterKeys', () => {
  it('apparie le Part sans tags au Join qui portait le notre', () => {
    const join = ev({ kind: 'join', tags: OURS });
    const part = ev({ kind: 'part', tags: null });

    const keys = toolChatterKeys([join, part]);

    expect(keys).toEqual(new Set([join.dedupKey, part.dedupKey]));
  });

  it('laisse passer le Part d’un vrai client, faute de dette ouverte', () => {
    const join = ev({ kind: 'join', tags: ['AP'] });
    const part = ev({ kind: 'part', tags: null });

    expect(toolChatterKeys([join, part]).size).toBe(0);
  });

  it('n’eponge qu’un Part par Join, le suivant est celui du joueur', () => {
    const ours = ev({ kind: 'join', tags: OURS });
    const theirs = ev({ kind: 'join', tags: ['AP'] });
    const first = ev({ kind: 'part' });
    const second = ev({ kind: 'part' });

    const keys = toolChatterKeys([ours, theirs, first, second]);

    expect(keys.has(first.dedupKey)).toBe(true);
    expect(keys.has(second.dedupKey)).toBe(false);
  });

  it('tient la dette par slot', () => {
    const ours = ev({ kind: 'join', tags: OURS, srcSlot: 1 });
    const other = ev({ kind: 'part', srcSlot: 2 });
    const mine = ev({ kind: 'part', srcSlot: 1 });

    const keys = toolChatterKeys([ours, other, mine]);

    expect(keys.has(other.dedupKey)).toBe(false);
    expect(keys.has(mine.dedupKey)).toBe(true);
  });

  it('ne reporte pas une dette d’une session sur la suivante', () => {
    const ours = ev({ kind: 'join', tags: OURS, sessionId: 1 });
    const later = ev({ kind: 'part', sessionId: 2 });

    const keys = toolChatterKeys([ours, later]);

    expect(keys.has(ours.dedupKey)).toBe(true);
    expect(keys.has(later.dedupKey)).toBe(false);
  });

  it('ignore les evenements sans slot emetteur', () => {
    expect(toolChatterKeys([ev({ kind: 'part', srcSlot: null })]).size).toBe(0);
  });

  it('ne retient que les Join et les Part', () => {
    expect(toolChatterKeys([ev({ kind: 'item', tags: OURS })]).size).toBe(0);
  });
});
