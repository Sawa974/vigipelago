import { describe, expect, it } from 'vitest';
import type { Hint } from '../protocol/types';
import { computeHintGaps, hintDedupSuffix, hintsKey, parseHintsKey } from './hints';

/** Au format reel du data storage. */
function hint(part: Partial<Hint> & { location: number }): Hint {
  return {
    receiving_player: 2,
    finding_player: 1,
    item: 500,
    found: false,
    entrance: '',
    item_flags: 0b001,
    status: 0,
    ...part,
  };
}

const BASE = { team: 0, knownSuffixes: new Set<string>(), tsLower: 1_700_000_000_000, tsUpper: 1_700_000_900_000 };

describe('hintsKey', () => {
  it('porte le prefixe reserve, qui ne fait pas partie du nom de la cle', () => {
    expect(hintsKey(0, 3)).toBe('_read_hints_0_3');
    expect(parseHintsKey('_read_hints_0_3')).toEqual({ team: 0, slot: 3 });
  });

  it('ne reconnait pas une autre cle du data storage', () => {
    expect(parseHintsKey('_read_client_status_0_3')).toBeNull();
    expect(parseHintsKey('hints_0_3')).toBeNull();
  });
});

describe('computeHintGaps', () => {
  it('rattrape un hint jamais entendu', () => {
    const gaps = computeHintGaps({ ...BASE, hints: [hint({ location: 10 })] });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ srcSlot: 1, dstSlot: 2, itemId: 500, locationId: 10 });
  });

  it('horodate en approximatif, jamais en instant precis', () => {
    const gaps = computeHintGaps({ ...BASE, hints: [hint({ location: 10 })] });
    expect(gaps[0].tsLower).toBe(1_700_000_000_000);
    expect(gaps[0].tsUpper).toBe(1_700_000_900_000);
    expect(gaps[0].ts).toBe(1_700_000_450_000);
  });

  it('garde des bornes ordonnees meme si la couverture est incoherente', () => {
    const gaps = computeHintGaps({
      ...BASE,
      tsLower: 1_700_000_900_001,
      hints: [hint({ location: 10 })],
    });
    expect(gaps[0].tsLower).toBeLessThanOrEqual(gaps[0].tsUpper);
  });

  it('ne compte qu’une fois un hint vu sous ses deux joueurs', () => {
    const same = hint({ location: 10, finding_player: 1, receiving_player: 2 });
    const gaps = computeHintGaps({ ...BASE, hints: [same, { ...same }] });
    expect(gaps).toHaveLength(1);
  });

  it('ne rattrape pas un hint deja au journal', () => {
    const gaps = computeHintGaps({
      ...BASE,
      hints: [hint({ location: 10 }), hint({ location: 11 })],
      knownSuffixes: new Set([hintDedupSuffix(0, 1, 10)]),
    });
    expect(gaps.map((g) => g.locationId)).toEqual([11]);
  });

  it('ecarte un hint deja honore : le fait l’emporte toujours sur le hint', () => {
    const gaps = computeHintGaps({
      ...BASE,
      hints: [hint({ location: 10, found: true }), hint({ location: 11, found: false })],
    });
    expect(gaps.map((g) => g.locationId)).toEqual([11]);
  });

  it('la cle de dedup ne depend ni du texte ni de l’instant', () => {
    expect(hintDedupSuffix(0, 1, 10)).toBe('h:0:1:10');
    const a = computeHintGaps({ ...BASE, hints: [hint({ location: 10 })] })[0];
    const b = computeHintGaps({
      ...BASE,
      tsLower: 1,
      tsUpper: 2,
      hints: [hint({ location: 10 })],
    })[0];
    expect(a.dedupSuffix).toBe(b.dedupSuffix);
  });

  it('deux emplacements du meme monde donnent deux hints distincts', () => {
    const gaps = computeHintGaps({
      ...BASE,
      hints: [hint({ location: 10 }), hint({ location: 11 })],
    });
    expect(new Set(gaps.map((g) => g.dedupSuffix)).size).toBe(2);
  });

  it('le meme emplacement dans deux mondes differents ne se confond pas', () => {
    const gaps = computeHintGaps({
      ...BASE,
      hints: [hint({ location: 10, finding_player: 1 }), hint({ location: 10, finding_player: 3 })],
    });
    expect(gaps.map((g) => g.dedupSuffix)).toEqual(['h:0:1:10', 'h:0:3:10']);
  });

  it('garde l’entree quand le jeu en declare une, et les drapeaux de l’objet', () => {
    const gaps = computeHintGaps({
      ...BASE,
      hints: [hint({ location: 10, entrance: 'Mine Entrance', item_flags: 0b100 })],
    });
    expect(gaps[0]).toMatchObject({ entrance: 'Mine Entrance', itemFlags: 0b100 });
  });

  it('ignore une entree du data storage qui n’a pas la forme attendue', () => {
    const gaps = computeHintGaps({
      ...BASE,
      hints: [{ location: 10 } as Hint, hint({ location: 11 })],
    });
    expect(gaps.map((g) => g.locationId)).toEqual([11]);
  });

  it('une liste vide ne rattrape rien', () => {
    expect(computeHintGaps({ ...BASE, hints: [] })).toEqual([]);
  });
});
