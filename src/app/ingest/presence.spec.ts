import { describe, expect, it } from 'vitest';
import type { PresenceInterval } from '../db/db';
import { VIGIPELAGO_TAG } from '../protocol/tags';
import { PresenceTracker, type PresenceOp } from './presence';

function harness() {
  const ops: PresenceOp[] = [];
  const tracker = new PresenceTracker((op) => ops.push(op));
  const closed = () =>
    ops.filter((o) => o.type === 'close').map((o) => ({ ...(o.interval as PresenceInterval) }));
  return { tracker, ops, closed };
}

describe('PresenceTracker', () => {
  it('demarre tout le monde en inconnu, jamais en deconnecte', () => {
    const { tracker } = harness();
    tracker.begin('seed', 0, [1, 2], 1000);
    expect(tracker.stateOf(1)).toBe('unknown');
    expect(tracker.stateOf(2)).toBe('unknown');
  });

  it('passe en ligne sur le Join d un client de jeu, hors ligne au depart du dernier', () => {
    const { tracker } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.join(1, ['AP'], 2000);
    expect(tracker.stateOf(1)).toBe('online');
    tracker.part(1, 5000);
    expect(tracker.stateOf(1)).toBe('offline');
  });

  it('traite un client sans aucun tag comme un client de jeu', () => {
    const { tracker } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.join(1, [], 2000);
    expect(tracker.stateOf(1)).toBe('online');
  });

  it('ignore nos propres Join grace au tag', () => {
    const { tracker } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.join(1, ['TextOnly', VIGIPELAGO_TAG], 2000);
    expect(tracker.stateOf(1)).toBe('unknown');
  });

  it('apparie nos Part a nos Join, le Part ne portant aucun tag', () => {
    const { tracker } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.join(1, ['AP'], 2000);
    tracker.join(1, ['TextOnly', VIGIPELAGO_TAG], 3000);
    tracker.part(1, 4000);
    expect(tracker.stateOf(1)).toBe('online');

    tracker.part(1, 5000);
    expect(tracker.stateOf(1)).toBe('offline');
  });

  it('distingue un observateur d un joueur connecte', () => {
    const { tracker } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.join(1, ['Tracker'], 2000);
    expect(tracker.stateOf(1)).toBe('observer');
    tracker.join(1, ['AP'], 3000);
    expect(tracker.stateOf(1)).toBe('online');
  });

  it('reste en ligne tant qu un client demeure, faute de savoir lequel est parti', () => {
    const { tracker } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.join(1, ['AP'], 2000);
    tracker.join(1, ['Tracker'], 2500);
    tracker.part(1, 3000);
    expect(tracker.stateOf(1)).toBe('online');
    tracker.part(1, 4000);
    expect(tracker.stateOf(1)).toBe('offline');
  });

  it('borne a zero un Part vu sans son Join', () => {
    const { tracker } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.part(1, 2000);
    expect(tracker.stateOf(1)).toBe('offline');
    tracker.join(1, ['AP'], 3000);
    expect(tracker.stateOf(1)).toBe('online');
  });

  it('promeut un inconnu en ligne quand une activite le prouve', () => {
    const { tracker, closed } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.activity(1, 3000);
    expect(tracker.stateOf(1)).toBe('online');
    expect(closed()[0]).toMatchObject({ state: 'unknown', from: 1000, to: 3000 });
  });

  it('laisse une activite corriger un hors ligne, un check etant une preuve plus forte', () => {
    const { tracker } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.join(1, ['AP'], 1500);
    tracker.part(1, 2000);
    expect(tracker.stateOf(1)).toBe('offline');
    tracker.activity(1, 3000);
    expect(tracker.stateOf(1)).toBe('online');
  });

  it('ne repasse pas par une deduction quand un client de jeu est deja atteste', () => {
    const { tracker, ops } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.join(1, ['AP'], 2000);
    const before = ops.length;
    tracker.activity(1, 3000);
    expect(ops.length).toBe(before);
  });

  it('ignore un Join redondant plutot que de fragmenter l intervalle', () => {
    const { tracker, ops } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.join(1, ['AP'], 2000);
    const before = ops.length;
    tracker.join(1, ['AP'], 4000);
    expect(ops.length).toBe(before);
  });

  it('marque la source : observe quand un Join l atteste, deduit sinon', () => {
    const { tracker, ops } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.activity(1, 2000);
    tracker.join(1, ['AP'], 3000);
    const opened = ops.filter((o) => o.type === 'open').map((o) => o.interval);
    expect(opened[1]).toMatchObject({ state: 'online', source: 'assumed' });
    expect(opened[2]).toMatchObject({ state: 'online', source: 'observed' });
  });

  it('referme tout en fin de session sans inventer un etat deconnecte', () => {
    const { tracker, closed } = harness();
    tracker.begin('seed', 0, [1, 2], 1000);
    tracker.join(1, ['AP'], 2000);
    tracker.end(9000);
    expect(tracker.stateOf(1)).toBeNull();
    const ends = closed().filter((i) => i.to === 9000);
    expect(ends).toHaveLength(2);
    expect(ends.map((i) => i.state).sort()).toEqual(['online', 'unknown']);
  });

  it('expose le detail des clients par categorie', () => {
    const { tracker } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.join(1, ['AP'], 2000);
    tracker.join(1, ['Tracker'], 2100);
    tracker.join(1, ['TextOnly', VIGIPELAGO_TAG], 2200);
    expect(tracker.snapshot()).toEqual([
      { slot: 1, state: 'online', players: 1, observers: 1, textClient: false },
    ]);
  });

  it('compte l observateur comme joueur sur un slot declare client texte', () => {
    const { tracker } = harness();
    tracker.begin('seed', 0, [1], 1000);
    tracker.join(1, ['TextOnly'], 2000);
    expect(tracker.stateOf(1)).toBe('observer');

    tracker.setTextClientSlots(new Set([1]), 3000);
    expect(tracker.stateOf(1)).toBe('online');

    tracker.setTextClientSlots(new Set(), 4000);
    expect(tracker.stateOf(1)).toBe('observer');
  });
});
