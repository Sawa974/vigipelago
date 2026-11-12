import { describe, expect, it } from 'vitest';
import { computeGapChecks, selectScoutTargets } from './reconcile';

describe('computeGapChecks', () => {
  it('sans borne basse, la garde inconnue et trie a la borne haute', () => {
    const [g] = computeGapChecks({ checkedLocations: [10], knownLocationIds: new Set(), tsLower: null, tsUpper: 5000 });
    expect(g).toEqual({ locationId: 10, tsLower: null, tsUpper: 5000, ts: 5000 });
  });

  it('ne retient que les locations absentes du journal', () => {
    const gaps = computeGapChecks({
      checkedLocations: [10, 20, 30, 40],
      knownLocationIds: new Set([10, 30]),
      tsLower: 1000,
      tsUpper: 5000,
    });
    expect(gaps.map((g) => g.locationId)).toEqual([20, 40]);
  });

  it('encadre par des bornes et place ts au milieu, pour le seul tri', () => {
    const [gap] = computeGapChecks({
      checkedLocations: [7],
      knownLocationIds: new Set(),
      tsLower: 1000,
      tsUpper: 5000,
    });
    expect(gap.tsLower).toBe(1000);
    expect(gap.tsUpper).toBe(5000);
    expect(gap.ts).toBe(3000);
  });

  it('ne produit rien quand le journal est deja complet', () => {
    expect(
      computeGapChecks({
        checkedLocations: [1, 2, 3],
        knownLocationIds: new Set([1, 2, 3]),
        tsLower: 0,
        tsUpper: 10,
      }),
    ).toEqual([]);
  });

  it('garde les bornes ordonnees si la couverture depasse l instant du constat', () => {
    const [gap] = computeGapChecks({
      checkedLocations: [1],
      knownLocationIds: new Set(),
      tsLower: 9000,
      tsUpper: 5000,
    });
    expect(gap.tsLower).toBe(5000);
    expect(gap.ts).toBe(5000);
  });
});

describe('selectScoutTargets', () => {
  it("redemande une location dont la ligne existe mais n'a pas de contenu", () => {
    const targets = selectScoutTargets({
      checkedLocations: [10, 11, 12],
      resolvedLocationIds: new Set([10]),
    });
    expect(targets).toEqual([11, 12]);
  });

  it('ne redemande rien quand tout est resolu : l’ensemble converge', () => {
    expect(
      selectScoutTargets({ checkedLocations: [10, 11], resolvedLocationIds: new Set([10, 11]) }),
    ).toEqual([]);
  });

  it('garde l’ordre du serveur et ne demande pas deux fois la meme location', () => {
    expect(
      selectScoutTargets({ checkedLocations: [12, 10, 12, 11], resolvedLocationIds: new Set() }),
    ).toEqual([12, 10, 11]);
  });

  it('une liste vide ne demande rien', () => {
    expect(selectScoutTargets({ checkedLocations: [], resolvedLocationIds: new Set([10]) })).toEqual([]);
  });
});
