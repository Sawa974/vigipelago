import { describe, expect, it } from 'vitest';
import { ITEM_FLAG_TRAP, ITEM_FLAG_USEFUL } from './types';
import { decodePrintJson } from './decode';
import { NameResolver } from './names';
import type { PrintJsonPacket } from './types';

function resolver(): NameResolver {
  const n = new NameResolver();
  n.setPlayers(
    [
      { team: 0, slot: 1, name: 'Alice', alias: 'Alice' },
      { team: 0, slot: 2, name: 'Bob', alias: 'Bobby' },
    ],
    {
      '1': { name: 'Alice', game: 'A Link to the Past', type: 1, group_members: [] },
      '2': { name: 'Bob', game: 'Ocarina of Time', type: 1, group_members: [] },
    },
  );
  n.setGameData('A Link to the Past', { 100: 'Boomerang' }, { 200: "Link's House" });
  n.setGameData('Ocarina of Time', { 300: 'Hookshot' }, { 400: 'Deku Tree Chest' });
  n.ownSlot = 1;
  return n;
}

/** Alice trouve dans son monde le Hookshot destine a Bob. */
const itemSend: PrintJsonPacket = {
  cmd: 'PrintJSON',
  type: 'ItemSend',
  receiving: 2,
  item: { item: 300, location: 200, player: 1, flags: 0b001 },
  data: [
    { type: 'player_id', text: '1' },
    { type: 'text', text: ' sent ' },
    { type: 'item_id', text: '300', player: 2, flags: 0b001 },
    { type: 'text', text: ' to ' },
    { type: 'player_id', text: '2' },
    { type: 'text', text: ' (' },
    { type: 'location_id', text: '200', player: 1 },
    { type: 'text', text: ')' },
  ],
};

describe('decodePrintJson', () => {
  it('resout les identifiants via le jeu du bon joueur', () => {
    const ev = decodePrintJson(itemSend, resolver(), 1_700_000_000_000);
    expect(ev.text).toBe("Alice sent ✦ Hookshot to Bobby (Link's House)");
  });

  it('distingue emetteur et destinataire', () => {
    const ev = decodePrintJson(itemSend, resolver(), 1_700_000_000_000);
    expect(ev.kind).toBe('item');
    expect(ev.srcSlot).toBe(1);
    expect(ev.dstSlot).toBe(2);
    expect(ev.locationId).toBe(200);
    expect(ev.itemId).toBe(300);
  });

  it('marque le slot local et colore selon les flags', () => {
    const ev = decodePrintJson(itemSend, resolver(), 1_700_000_000_000);
    expect(ev.segments[0].cls).toBe('player-self');
    expect(ev.segments[4].cls).toBe('player-other');
    expect(ev.segments[2].cls).toBe('item-progression');
  });

  it('produit une cle de deduplication independante de l horodatage', () => {
    const a = decodePrintJson(itemSend, resolver(), 1_700_000_000_000);
    const b = decodePrintJson(itemSend, resolver(), 1_800_000_000_000);
    expect(a.dedupSuffix).toBe(b.dedupSuffix);
    expect(a.dedupSuffix).toBe('i:0:1:200');
  });

  it('ne marque que la progression et les pieges, pas les objets courants', () => {
    const useful: PrintJsonPacket = {
      ...itemSend,
      data: itemSend.data.map((d) => (d.type === 'item_id' ? { ...d, flags: ITEM_FLAG_USEFUL } : d)),
    };
    expect(decodePrintJson(useful, resolver(), 0).text).not.toContain('✦');

    const trap: PrintJsonPacket = {
      ...itemSend,
      data: itemSend.data.map((d) => (d.type === 'item_id' ? { ...d, flags: ITEM_FLAG_TRAP } : d)),
    };
    const ev = decodePrintJson(trap, resolver(), 0);
    expect(ev.text).toContain('▼');
    expect(ev.segments[2].cls).toBe('item-trap');
  });

  it('deduplique les messages sans location par contenu et minute', () => {
    const chat: PrintJsonPacket = {
      cmd: 'PrintJSON',
      type: 'Join',
      slot: 2,
      team: 0,
      data: [{ type: 'player_id', text: '2' }, { type: 'text', text: ' joined' }],
    };
    const a = decodePrintJson(chat, resolver(), 1_700_000_000_000);
    const b = decodePrintJson(chat, resolver(), 1_700_000_030_000);
    const c = decodePrintJson(chat, resolver(), 1_700_000_090_000);
    expect(a.kind).toBe('join');
    expect(a.dedupSuffix).toBe(b.dedupSuffix);
    expect(a.dedupSuffix).not.toBe(c.dedupSuffix);
  });

  it('replie sur des noms bruts quand le DataPackage manque', () => {
    const n = new NameResolver();
    const ev = decodePrintJson(itemSend, n, 1_700_000_000_000);
    expect(ev.text).toBe('Slot 1 sent ✦ Item 300 to Slot 2 (Location 200)');
  });
});
