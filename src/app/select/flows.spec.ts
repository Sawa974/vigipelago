import { describe, expect, it } from 'vitest';
import type { ApEvent } from '../db/db';
import { FLOW_ROW_LIMIT, buildFlows } from './flows';

let seq = 0;

function item(src: number | null, dst: number | null): ApEvent {
  seq += 1;
  return {
    roomId: 'seed',
    ts: seq * 1000,
    tsPrecision: 'exact',
    tsLower: null,
    tsUpper: null,
    kind: 'item',
    team: 0,
    srcSlot: src,
    dstSlot: dst,
    itemId: 1,
    locationId: 1,
    itemFlags: 0,
    text: '',
    segments: [],
    tags: null,
    sessionId: 1,
    raw: null,
    dedupKey: `k${seq}`,
  };
}

const NAMES = new Map<number, string>([
  [1, 'Alice'],
  [2, 'Bob'],
  [3, 'Carol'],
]);

describe('buildFlows', () => {
  it('ventile les envois par destinataire et les receptions par monde d origine', () => {
    const f = buildFlows({
      slot: 1,
      names: NAMES,
      outbound: [item(1, 2), item(1, 2), item(1, 3)],
      inbound: [item(3, 1)],
    });
    expect(f.sentTotal).toBe(3);
    expect(f.sent.map((r) => [r.name, r.count])).toEqual([
      ['Bob', 2],
      ['Carol', 1],
    ]);
    expect(f.received.map((r) => [r.name, r.count])).toEqual([['Carol', 1]]);
    expect(f.sentPartners).toBe(2);
  });

  it('compte un envoi a soi-meme comme n importe quel autre', () => {
    const f = buildFlows({ slot: 1, names: NAMES, outbound: [item(1, 1)], inbound: [] });
    expect(f.sent).toEqual([{ slot: 1, name: 'Alice', count: 1, share: 1, players: 1 }]);
  });

  it('sort les objets sans monde d origine du total ventile', () => {
    const f = buildFlows({
      slot: 1,
      names: NAMES,
      outbound: [],
      inbound: [item(2, 1), item(null, 1), item(null, 1)],
    });
    expect(f.receivedTotal).toBe(1);
    expect(f.unplacedReceived).toBe(2);
    expect(f.received.map((r) => r.slot)).toEqual([2]);
  });

  it('la part est celle du total affiche, pas un avancement', () => {
    const f = buildFlows({
      slot: 1,
      names: NAMES,
      outbound: [item(1, 2), item(1, 2), item(1, 2), item(1, 3)],
      inbound: [],
    });
    expect(f.sent[0].share).toBe(0.75);
    expect(f.sent[1].share).toBe(0.25);
  });

  it('ne regroupe rien tant que les lignes tiennent', () => {
    const names = new Map<number, string>();
    const outbound: ApEvent[] = [];
    for (let i = 1; i <= FLOW_ROW_LIMIT; i++) {
      names.set(i, `J${i}`);
      outbound.push(item(0, i));
    }
    const f = buildFlows({ slot: 0, names, outbound, inbound: [] });
    expect(f.sent).toHaveLength(FLOW_ROW_LIMIT);
    expect(f.sent.every((r) => r.slot !== null)).toBe(true);
  });

  it('nomme un reste d un seul joueur au lieu de le regrouper', () => {
    const names = new Map<number, string>();
    const outbound: ApEvent[] = [];
    for (let i = 1; i <= FLOW_ROW_LIMIT + 1; i++) {
      names.set(i, `J${i}`);
      outbound.push(item(0, i));
    }
    const f = buildFlows({ slot: 0, names, outbound, inbound: [] });
    expect(f.sent).toHaveLength(FLOW_ROW_LIMIT + 1);
    expect(f.sent.every((r) => r.slot !== null)).toBe(true);
  });

  it('regroupe des qu il reste au moins deux joueurs, et garde le total juste', () => {
    const names = new Map<number, string>();
    const outbound: ApEvent[] = [];
    for (let i = 1; i <= FLOW_ROW_LIMIT + 2; i++) {
      names.set(i, `J${i}`);
      const n = FLOW_ROW_LIMIT + 3 - i;
      for (let k = 0; k < n; k++) outbound.push(item(0, i));
    }
    const f = buildFlows({ slot: 0, names, outbound, inbound: [] });

    expect(f.sent).toHaveLength(FLOW_ROW_LIMIT + 1);
    const last = f.sent[f.sent.length - 1];
    expect(last.slot).toBeNull();
    expect(last.players).toBe(2);
    expect(last.name).toBe('');
    expect(last.players).toBe(2);
    expect(f.sent.reduce((n, r) => n + r.count, 0)).toBe(f.sentTotal);
    expect(f.sentPartners).toBe(FLOW_ROW_LIMIT + 2);
  });

  it('ignore ce qui n est pas un objet', () => {
    const hint = { ...item(1, 2), kind: 'hint' as const };
    const f = buildFlows({ slot: 1, names: NAMES, outbound: [hint], inbound: [hint] });
    expect(f.sentTotal).toBe(0);
    expect(f.receivedTotal).toBe(0);
  });

  it('nomme un slot inconnu par son numero plutot que de le taire', () => {
    const f = buildFlows({ slot: 1, names: new Map(), outbound: [item(1, 7)], inbound: [] });
    expect(f.sent[0].name).toBe('Slot 7');
  });
});
