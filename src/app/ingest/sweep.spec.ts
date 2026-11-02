import { describe, expect, it } from 'vitest';
import type { NetworkSlot } from '../protocol/types';
import { decideSweep, selectSweepTargets, SWEEP_GAP_THRESHOLD_MS } from './sweep';

const M = 60_000;

function slot(name: string, type: number): NetworkSlot {
  return { name, game: 'Jeu', type, group_members: [] };
}

describe('decideSweep', () => {
  it('balaye si la room n a jamais ete balayee', () => {
    expect(decideSweep([], null, 100 * M, true)).toMatchObject({ sweep: true, reason: 'jamais-balaye' });
  });

  it('ne balaye pas quand la couverture est continue depuis le dernier passage', () => {
    const cov = [{ from: 0, to: 100 * M }];
    expect(decideSweep(cov, 10 * M, 100 * M, true)).toMatchObject({
      sweep: false,
      reason: 'couverture-continue',
      gapMs: 0,
    });
  });

  it('balaye quand un trou depasse le seuil', () => {
    const cov = [{ from: 0, to: 10 * M }];
    const d = decideSweep(cov, 5 * M, 100 * M, true);
    expect(d.sweep).toBe(true);
    expect(d.reason).toBe('trou-detecte');
    expect(d.gapMs).toBe(90 * M);
  });

  it('ignore un hoquet de reconnexion plus court que le seuil', () => {
    const cov = [
      { from: 0, to: 50 * M },
      { from: 50 * M + 10_000, to: 100 * M },
    ];
    const d = decideSweep(cov, 10 * M, 100 * M, true);
    expect(d.gapMs).toBe(10_000);
    expect(d.gapMs).toBeLessThan(SWEEP_GAP_THRESHOLD_MS);
    expect(d.sweep).toBe(false);
  });

  it('ne balaye jamais quand l option est desactivee', () => {
    expect(decideSweep([], null, 0, false)).toMatchObject({ sweep: false, reason: 'desactive' });
  });
});

describe('selectSweepTargets', () => {
  const slotInfo: Record<string, NetworkSlot> = {
    '1': slot('Alice', 1),
    '2': slot('Bob', 1),
    '3': slot('ItemLink', 2),
    '4': slot('Spectateur', 0),
  };

  it('ne retient que les vrais joueurs', () => {
    expect(selectSweepTargets(slotInfo, null)).toEqual([
      { slot: 1, name: 'Alice' },
      { slot: 2, name: 'Bob' },
    ]);
  });

  it('exclut le slot deja reconcilie par la session principale', () => {
    expect(selectSweepTargets(slotInfo, 1)).toEqual([{ slot: 2, name: 'Bob' }]);
  });
});
