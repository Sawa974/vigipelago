import { describe, expect, it } from 'vitest';
import type { NetworkItem } from '../protocol/types';
import { computeReceivedGaps, placedDedupKey } from './received-items';

const item = (over: Partial<NetworkItem>): NetworkItem => ({
  item: 1,
  location: 100,
  player: 2,
  flags: 0,
  ...over,
});

describe('computeReceivedGaps', () => {
  it('ne retient que les objets absents du journal', () => {
    const gaps = computeReceivedGaps({
      roomId: 'R',
      team: 0,
      dstSlot: 1,
      items: [
        item({ location: 100, player: 2 }),
        item({ location: 200, player: 3 }),
        item({ location: 300, player: 2 }),
      ],
      knownKeys: new Set([placedDedupKey('R', 0, 2, 100)]),
      tsLower: 1000,
      tsUpper: 5000,
    });
    expect(gaps.map((g) => g.locationId)).toEqual([200, 300]);
  });

  it('reutilise la cle du check correspondant, pour que les deux rattrapages convergent', () => {
    const [gap] = computeReceivedGaps({
      roomId: 'R',
      team: 0,
      dstSlot: 1,
      items: [item({ location: 42, player: 7 })],
      knownKeys: new Set(),
      tsLower: 0,
      tsUpper: 10,
    });
    expect(gap.dedupKey).toBe('R|i:0:7:42');
    expect(gap.srcSlot).toBe(7);
  });

  it('identifie un objet non place par son rang, faute de location', () => {
    const gaps = computeReceivedGaps({
      roomId: 'R',
      team: 0,
      dstSlot: 1,
      items: [item({ location: -2, item: 5 }), item({ location: -2, item: 6 })],
      knownKeys: new Set(),
      tsLower: 0,
      tsUpper: 10,
    });
    expect(gaps.map((g) => g.dedupKey)).toEqual(['R|ri:0:1:0', 'R|ri:0:1:1']);
    expect(gaps.every((g) => g.srcSlot === null && g.locationId === null)).toBe(true);
  });

  it('garde le rang stable quand un objet place le precede', () => {
    const gaps = computeReceivedGaps({
      roomId: 'R',
      team: 0,
      dstSlot: 4,
      items: [item({ location: 100 }), item({ location: -1 })],
      knownKeys: new Set(),
      tsLower: 0,
      tsUpper: 10,
    });
    expect(gaps[1].dedupKey).toBe('R|ri:0:4:1');
  });

  it('classe la location zero comme placee, comme le fait le decodage des PrintJSON', () => {
    const [gap] = computeReceivedGaps({
      roomId: 'R',
      team: 0,
      dstSlot: 4,
      items: [item({ location: 0, player: 3 })],
      knownKeys: new Set(),
      tsLower: 0,
      tsUpper: 10,
    });
    expect(gap.dedupKey).toBe('R|i:0:3:0');
  });

  it('encadre par des bornes et place ts au milieu, pour le seul tri', () => {
    const [gap] = computeReceivedGaps({
      roomId: 'R',
      team: 0,
      dstSlot: 1,
      items: [item({})],
      knownKeys: new Set(),
      tsLower: 1000,
      tsUpper: 5000,
    });
    expect([gap.tsLower, gap.ts, gap.tsUpper]).toEqual([1000, 3000, 5000]);
  });

  it('garde les bornes ordonnees si la couverture depasse l instant du constat', () => {
    const [gap] = computeReceivedGaps({
      roomId: 'R',
      team: 0,
      dstSlot: 1,
      items: [item({})],
      knownKeys: new Set(),
      tsLower: 9000,
      tsUpper: 5000,
    });
    expect(gap.tsLower).toBe(5000);
    expect(gap.ts).toBe(5000);
  });

  it('conserve le drapeau d importance, deja porte par l objet', () => {
    const [gap] = computeReceivedGaps({
      roomId: 'R',
      team: 0,
      dstSlot: 1,
      items: [item({ flags: 0b001 })],
      knownKeys: new Set(),
      tsLower: 0,
      tsUpper: 10,
    });
    expect(gap.flags).toBe(0b001);
  });

  it('ne produit rien quand le journal est deja complet', () => {
    expect(
      computeReceivedGaps({
        roomId: 'R',
        team: 0,
        dstSlot: 1,
        items: [item({ location: 100, player: 2 })],
        knownKeys: new Set([placedDedupKey('R', 0, 2, 100)]),
        tsLower: 0,
        tsUpper: 10,
      }),
    ).toEqual([]);
  });
});
