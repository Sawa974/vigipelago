import { describe, expect, it } from 'vitest';
import type { ApEvent } from '../db/db';
import { buildSendRows, filterSendRows, type SendRow } from './sends';

/** Cles de dedup au format reel ; le slot 2 heberge des objets de deux jeux. */
function sendEvent(part: Partial<ApEvent> & { locationId: number }): ApEvent {
  const srcSlot = part.srcSlot ?? 2;
  return {
    roomId: 'Archipelago_1700000000',
    ts: 1_700_000_000_000,
    tsPrecision: 'exact',
    tsLower: null,
    tsUpper: null,
    kind: 'item',
    team: 0,
    srcSlot,
    dstSlot: 1,
    itemId: 500,
    itemFlags: 0b001,
    text: '',
    segments: [],
    tags: null,
    sessionId: 1,
    raw: null,
    dedupKey: `i:0:${srcSlot}:${part.locationId}`,
    ...part,
  };
}

function hintEvent(part: Partial<ApEvent> & { locationId: number }): ApEvent {
  return sendEvent({
    ...part,
    kind: 'hint',
    dedupKey: `x:hint:${part.locationId.toString(16)}:28333333`,
  });
}

const LOCATIONS: Record<number, string> = {
  10: 'Link Bedroom',
  11: 'Kings Tomb',
  12: 'Floodgate Chest',
};

const ITEM_CATALOGUES = new Map<number, Record<number, string>>([
  [1, { 500: 'Progressive Sword', 501: 'Bombos Medallion' }],
  [2, { 500: 'Rupee (50)' }],
  [3, { 500: 'Prismatic Shard' }],
]);

const PLAYER_NAMES = new Map<number, string>([
  [1, 'Zelda'],
  [2, 'Dana'],
  [3, 'Mario'],
]);

const BASE = {
  slot: 2,
  locationCatalogue: LOCATIONS,
  itemCatalogues: ITEM_CATALOGUES,
  playerNames: PLAYER_NAMES,
};

function lines(rows: readonly SendRow[]): string[] {
  return rows.map((r) => `${r.status} ${r.name} -> ${r.dstName} : ${r.itemName}`);
}

describe('buildSendRows', () => {
  it('ne retient que ce qui sort du monde regarde', () => {
    const res = buildSendRows({
      ...BASE,
      events: [
        sendEvent({ locationId: 10, srcSlot: 2 }),
        sendEvent({ locationId: 11, srcSlot: 3 }),
        sendEvent({ locationId: 12, srcSlot: 5, dstSlot: 2 }),
      ],
    });
    expect(lines(res.rows)).toEqual(['sent Link Bedroom -> Zelda : Progressive Sword']);
  });

  it("resout le nom de l'objet dans le jeu du destinataire, pas dans celui de l'hote", () => {
    const res = buildSendRows({
      ...BASE,
      events: [
        sendEvent({ locationId: 10, dstSlot: 1, itemId: 500 }),
        sendEvent({ locationId: 11, dstSlot: 3, itemId: 500 }),
      ],
    });
    expect(lines(res.rows).sort()).toEqual([
      'sent Kings Tomb -> Mario : Prismatic Shard',
      'sent Link Bedroom -> Zelda : Progressive Sword',
    ]);
  });

  it('un objet qui retombe dans son propre monde est marque, et compte a part', () => {
    const res = buildSendRows({
      ...BASE,
      events: [
        sendEvent({ locationId: 10, dstSlot: 1 }),
        sendEvent({ locationId: 11, dstSlot: 2 }),
      ],
    });
    expect(res.tally).toMatchObject({ sent: 2, toOthers: 1, toSelf: 1 });
    expect(res.rows.find((r) => r.name === 'Kings Tomb')?.toSelf).toBe(true);
    expect(res.rows.find((r) => r.name === 'Kings Tomb')?.itemName).toBe('Rupee (50)');
  });

  it('un hint sur un emplacement non fait reste a envoyer', () => {
    const res = buildSendRows({
      ...BASE,
      events: [hintEvent({ locationId: 12, dstSlot: 3 })],
    });
    expect(lines(res.rows)).toEqual(['pending Floodgate Chest -> Mario : Prismatic Shard']);
    expect(res.tally).toMatchObject({ sent: 0, pending: 1 });
  });

  it("un hint deja honore ne reclame plus rien : l'envoi l'emporte", () => {
    const res = buildSendRows({
      ...BASE,
      events: [hintEvent({ locationId: 10, dstSlot: 1 }), sendEvent({ locationId: 10, dstSlot: 1 })],
    });
    expect(lines(res.rows)).toEqual(['sent Link Bedroom -> Zelda : Progressive Sword']);
    expect(res.tally).toMatchObject({ sent: 1, pending: 0 });
  });

  it("un hint dont l'emplacement est fait se tait, meme sans savoir ce qui en est sorti", () => {
    const res = buildSendRows({
      ...BASE,
      events: [hintEvent({ locationId: 11, dstSlot: 3 })],
      snapshot: [11],
    });
    expect(res.rows).toEqual([]);
    expect(res.tally).toMatchObject({ pending: 0, doneWithoutItem: 1 });
  });

  it("chiffre les envois que le journal ne sait pas detailler, snapshot ou pas", () => {
    const res = buildSendRows({
      ...BASE,
      events: [sendEvent({ locationId: 10 })],
      checkedFromServer: 7,
    });
    expect(res.tally.doneWithoutItem).toBe(6);
  });

  it("ne compte pas un objet injecte par la console comme un envoi", () => {
    const res = buildSendRows({
      ...BASE,
      events: [sendEvent({ locationId: -1, dstSlot: 1 })],
    });
    expect(res.rows).toEqual([]);
    expect(res.tally.sent).toBe(0);
  });

  it("garde l'instant exact d'un envoi vu en direct contre celui d'un rattrapage", () => {
    const res = buildSendRows({
      ...BASE,
      events: [
        sendEvent({ locationId: 10, ts: 1_700_000_900_000, tsPrecision: 'approx' }),
        sendEvent({ locationId: 10, ts: 1_700_000_100_000 }),
      ],
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].approx).toBe(false);
    expect(res.rows[0].ts).toBe(1_700_000_100_000);
  });

  it('le plus recent en tete : le plafond coupe les plus vieilles lignes', () => {
    const res = buildSendRows({
      ...BASE,
      events: [
        sendEvent({ locationId: 10, ts: 1_700_000_100_000 }),
        sendEvent({ locationId: 12, ts: 1_700_000_300_000 }),
        sendEvent({ locationId: 11, ts: 1_700_000_200_000 }),
      ],
    });
    expect(res.rows.map((r) => r.name)).toEqual(['Floodgate Chest', 'Kings Tomb', 'Link Bedroom']);
  });

  it("nomme les destinataires dont le catalogue manque, et fabrique un nom d'objet", () => {
    const res = buildSendRows({
      ...BASE,
      itemCatalogues: new Map([[1, { 500: 'Progressive Sword' }]]),
      events: [sendEvent({ locationId: 11, dstSlot: 3, itemId: 777 })],
    });
    expect(res.rows[0].itemName).toBe('Item 777');
    expect(res.rows[0].itemUnresolved).toBe(true);
    expect(res.itemCataloguesMissing).toEqual(['Mario']);
  });

  it("sans catalogue d'emplacements, les noms sont des ids et cela se dit", () => {
    const res = buildSendRows({
      ...BASE,
      locationCatalogue: null,
      events: [sendEvent({ locationId: 10 })],
    });
    expect(res.rows[0].name).toBe('Location 10');
    expect(res.rows[0].unresolved).toBe(true);
    expect(res.catalogueMissing).toBe(true);
  });

  it("classe l'objet d'apres ses drapeaux, et pas d'apres le monde qui l'heberge", () => {
    const res = buildSendRows({
      ...BASE,
      events: [
        sendEvent({ locationId: 10, itemFlags: 0b001 }),
        sendEvent({ locationId: 11, itemFlags: 0b100 }),
        sendEvent({ locationId: 12, itemFlags: null }),
      ],
    });
    const byName = Object.fromEntries(res.rows.map((r) => [r.name, r.cls]));
    expect(byName).toEqual({
      'Link Bedroom': 'progression',
      'Kings Tomb': 'trap',
      'Floodgate Chest': 'unknown',
    });
  });
});

describe('filterSendRows', () => {
  const ROWS = buildSendRows({
    ...BASE,
    events: [
      sendEvent({ locationId: 10, dstSlot: 1, ts: 1_700_000_100_000 }),
      hintEvent({ locationId: 12, dstSlot: 3, ts: 1_700_000_200_000 }),
    ],
  }).rows;

  it('« Tous » montre les deux statuts : aucun n’est deduit d’un catalogue', () => {
    const view = filterSendRows(ROWS, { text: '', status: 'all', limit: 100 });
    expect(view.matched).toBe(2);
    expect(view.catalogueWithheld).toBe(false);
  });

  it('un statut choisi ne montre que lui', () => {
    expect(filterSendRows(ROWS, { text: '', status: 'pending', limit: 100 }).rows.map((r) => r.name)).toEqual([
      'Floodgate Chest',
    ]);
  });

  it('le filtre texte atteint les trois noms de la ligne', () => {
    for (const needle of ['link bed', 'progressive', 'zelda']) {
      expect(filterSendRows(ROWS, { text: needle, status: 'all', limit: 100 }).rows.map((r) => r.name)).toEqual(
        ['Link Bedroom'],
      );
    }
  });

  it('le plafond coupe et le dit', () => {
    const view = filterSendRows(ROWS, { text: '', status: 'all', limit: 1 });
    expect(view.rows).toHaveLength(1);
    expect(view.matched).toBe(2);
    expect(view.truncated).toBe(true);
  });
});
