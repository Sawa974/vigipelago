import { describe, expect, it } from 'vitest';
import type { ApEvent } from '../db/db';
import { buildItemRows, filterItemRows, type ItemRow } from './items';
import { ITEM_FLAG_PROGRESSION, ITEM_FLAG_TRAP } from '../protocol/types';

/** Cles de dedup au format reel : une cle simplifiee ne testerait pas l'idempotence. */
function item(part: Partial<ApEvent> & { itemId: number }): ApEvent {
  const srcSlot = part.srcSlot ?? 1;
  const locationId = part.locationId ?? part.itemId * 10;
  return {
    roomId: 'Archipelago_1700000000',
    ts: 1_700_000_000_000,
    tsPrecision: 'exact',
    tsLower: null,
    tsUpper: null,
    kind: 'item',
    team: 0,
    srcSlot,
    dstSlot: 2,
    locationId,
    itemFlags: 0,
    text: '',
    segments: [],
    tags: null,
    sessionId: 1,
    raw: null,
    dedupKey: `i:0:${srcSlot}:${locationId}`,
    ...part,
  };
}

function hint(part: Partial<ApEvent> & { itemId: number }): ApEvent {
  return item({ ...part, kind: 'hint', dedupKey: `x:hint:${part.itemId.toString(16)}:28333333` });
}

const CATALOGUE: Record<number, string> = {
  100: 'Progressive Sword',
  101: 'Bombos',
  102: 'Hookshot',
  103: 'Moon Pearl',
  104: 'Magic Mirror',
};

/** Le meme id 10 dans les deux tables : une resolution dans le mauvais jeu doit echouer. */
const LOCATIONS_BY_SLOT = new Map<number, Record<number, string>>([
  [1, { 10: 'Link Bedroom', 1010: 'Kings Tomb', 1020: 'Spiral Cave' }],
  [3, { 10: 'Fishing Pond', 1010: 'Mine Lv.40' }],
]);

const PLAYER_NAMES = new Map<number, string>([
  [1, 'Zelda'],
  [2, 'Dana'],
  [3, 'Mario'],
]);

const RESOLVE = { locationCatalogues: LOCATIONS_BY_SLOT, playerNames: PLAYER_NAMES };

function byName(rows: readonly ItemRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [r.name, r.status]));
}

describe('buildItemRows', () => {
  it('ne melange pas les destinataires', () => {
    const res = buildItemRows({
      ...RESOLVE,
      events: [
        item({ itemId: 101, dstSlot: 2 }),
        item({ itemId: 102, dstSlot: 3 }),
      ],
      slot: 2,
      catalogue: CATALOGUE,
      includeMissing: false,
    });
    expect(res.rows.map((r) => r.name)).toEqual(['Bombos']);
  });

  it('recouvre partiellement le catalogue : recu, hinte, et le reste', () => {
    const res = buildItemRows({
      ...RESOLVE,
      events: [
        item({ itemId: 100, itemFlags: ITEM_FLAG_PROGRESSION, locationId: 1000 }),
        item({ itemId: 100, itemFlags: ITEM_FLAG_PROGRESSION, locationId: 1001, ts: 1_700_000_060_000 }),
        item({ itemId: 101, itemFlags: ITEM_FLAG_TRAP }),
        hint({ itemId: 101 }),
        hint({ itemId: 102, itemFlags: ITEM_FLAG_PROGRESSION }),
      ],
      slot: 2,
      catalogue: CATALOGUE,
      includeMissing: true,
    });

    expect(byName(res.rows)).toEqual({
      Bombos: 'received',
      Hookshot: 'hinted',
      'Magic Mirror': 'missing',
      'Moon Pearl': 'missing',
      'Progressive Sword': 'received',
    });
    expect(res.tally).toEqual({ received: 2, hinted: 1, missing: 2, copies: 3 });

    const sword = res.rows.find((r) => r.name === 'Progressive Sword')!;
    expect(sword.count).toBe(2);
    expect(sword.cls).toBe('progression');
    expect(sword.lastTs).toBe(1_700_000_060_000);
  });

  it('omet le reste du catalogue pour un autre joueur, mais garde ses faits publics', () => {
    const res = buildItemRows({
      ...RESOLVE,
      events: [item({ itemId: 101 }), hint({ itemId: 102 })],
      slot: 2,
      catalogue: CATALOGUE,
      includeMissing: false,
    });
    expect(byName(res.rows)).toEqual({ Bombos: 'received', Hookshot: 'hinted' });
    expect(res.tally.missing).toBe(3);
  });

  it('nomme un id absent du catalogue sans le compter dans le reste', () => {
    const res = buildItemRows({
      ...RESOLVE,
      events: [item({ itemId: 999 })],
      slot: 2,
      catalogue: CATALOGUE,
      includeMissing: true,
    });
    const orphan = res.rows.find((r) => r.id === 999)!;
    expect(orphan.name).toBe('Objet 999');
    expect(orphan.unresolved).toBe(true);
    expect(res.rows.at(-1)).toBe(orphan);
    expect(res.tally).toMatchObject({ received: 1, missing: 5 });
  });

  it('sans DataPackage, le reste est inconnu et non nul', () => {
    const res = buildItemRows({
      ...RESOLVE,
      events: [item({ itemId: 101 })],
      slot: 2,
      catalogue: null,
      includeMissing: true,
    });
    expect(res.catalogueMissing).toBe(true);
    expect(res.tally.missing).toBeNull();
    expect(res.rows.map((r) => r.name)).toEqual(['Objet 101']);
  });

  it('un rattrapage sans contenu resolu n’efface pas la classe deja connue', () => {
    const res = buildItemRows({
      ...RESOLVE,
      events: [
        item({ itemId: 100, itemFlags: ITEM_FLAG_PROGRESSION, locationId: 1000 }),
        item({ itemId: 100, itemFlags: null, locationId: 1001, tsPrecision: 'approx' }),
      ],
      slot: 2,
      catalogue: CATALOGUE,
      includeMissing: false,
    });
    expect(res.rows[0].cls).toBe('progression');
  });
});

describe('filterItemRows', () => {
  const rows = buildItemRows({
      ...RESOLVE,
    events: [item({ itemId: 100 }), hint({ itemId: 102 })],
    slot: 2,
    catalogue: CATALOGUE,
    includeMissing: true,
  }).rows;

  it('« Tous » montre les faits et retient le catalogue', () => {
    const res = filterItemRows(rows, { text: '', status: 'all', limit: 100 });
    expect(res.rows.map((r) => r.name)).toEqual(['Hookshot', 'Progressive Sword']);
    expect(res.matched).toBe(2);
    expect(res.catalogueWithheld).toBe(true);
  });

  it('et le cherche aussi : un nom du catalogue ne sort pas sous « Tous »', () => {
    expect(filterItemRows(rows, { text: 'moon', status: 'all', limit: 100 }).rows).toEqual([]);
    expect(filterItemRows(rows, { text: 'moon', status: 'missing', limit: 100 }).rows.map((r) => r.name)).toEqual([
      'Moon Pearl',
    ]);
  });

  it('ne signale rien a retenir quand il n’y a pas de catalogue a montrer', () => {
    const facts = buildItemRows({
      ...RESOLVE,
      events: [item({ itemId: 100 })],
      slot: 2,
      catalogue: CATALOGUE,
      includeMissing: false,
    }).rows;
    expect(filterItemRows(facts, { text: '', status: 'all', limit: 100 }).catalogueWithheld).toBe(false);
  });

  it('cherche sans tenir compte de la casse', () => {
    const res = filterItemRows(rows, { text: 'HOOK', status: 'all', limit: 100 });
    expect(res.rows.map((r) => r.name)).toEqual(['Hookshot']);
    expect(res.truncated).toBe(false);
  });

  it('croise texte et statut', () => {
    expect(filterItemRows(rows, { text: 'o', status: 'missing', limit: 100 }).rows.map((r) => r.name)).toEqual([
      'Bombos',
      'Magic Mirror',
      'Moon Pearl',
    ]);
  });

  it('garde le total quand le plafond coupe', () => {
    const res = filterItemRows(rows, { text: '', status: 'missing', limit: 2 });
    expect(res.rows).toHaveLength(2);
    expect(res.matched).toBe(3);
    expect(res.truncated).toBe(true);
  });
});

describe('provenance des objets recus', () => {
  it("nomme le monde d'origine et l'emplacement, resolu dans le jeu de ce monde-la", () => {
    const res = buildItemRows({
      ...RESOLVE,
      events: [item({ itemId: 101, srcSlot: 3, locationId: 1010 })],
      slot: 2,
      catalogue: CATALOGUE,
      includeMissing: false,
    });
    const src = res.rows[0].sources[0];
    expect(src.playerName).toBe('Mario');
    expect(src.locationName).toBe('Mine Lv.40');
    expect(src.unresolved).toBe(false);
  });

  it('un hint dit lui aussi ou dort l’objet', () => {
    const res = buildItemRows({
      ...RESOLVE,
      events: [hint({ itemId: 102, srcSlot: 1, locationId: 1020 })],
      slot: 2,
      catalogue: CATALOGUE,
      includeMissing: false,
    });
    expect(res.rows[0].status).toBe('hinted');
    expect(res.rows[0].sources[0]).toMatchObject({ playerName: 'Zelda', locationName: 'Spiral Cave' });
  });

  it('un objet recu plusieurs fois garde toutes ses provenances, la plus recente en tete', () => {
    const res = buildItemRows({
      ...RESOLVE,
      events: [
        item({ itemId: 100, srcSlot: 1, locationId: 10, ts: 1_700_000_100_000 }),
        item({ itemId: 100, srcSlot: 3, locationId: 1010, ts: 1_700_000_300_000 }),
        item({ itemId: 100, srcSlot: 1, locationId: 1010, ts: 1_700_000_200_000 }),
      ],
      slot: 2,
      catalogue: CATALOGUE,
      includeMissing: false,
    });
    const row = res.rows[0];
    expect(row.count).toBe(3);
    expect(row.sources.map((s) => s.locationName)).toEqual(['Mine Lv.40', 'Kings Tomb', 'Link Bedroom']);
    expect(row.sources.map((s) => s.playerName)).toEqual(['Mario', 'Zelda', 'Zelda']);
  });

  it("un objet accorde par le serveur n'a pas de provenance, et ne s'en invente pas", () => {
    const res = buildItemRows({
      ...RESOLVE,
      events: [item({ itemId: 103, srcSlot: null, locationId: -1 })],
      slot: 2,
      catalogue: CATALOGUE,
      includeMissing: false,
    });
    expect(res.rows[0].sources[0]).toMatchObject({
      slot: null,
      playerName: null,
      locationName: null,
    });
  });

  it("sans le catalogue du monde d'origine, l'emplacement porte son id et le signale", () => {
    const res = buildItemRows({
      ...RESOLVE,
      events: [item({ itemId: 101, srcSlot: 7, locationId: 42 })],
      slot: 2,
      catalogue: CATALOGUE,
      includeMissing: false,
    });
    expect(res.rows[0].sources[0]).toMatchObject({
      playerName: 'Slot 7',
      locationName: 'Emplacement 42',
      unresolved: true,
    });
  });

  it("le reste du catalogue n'a aucune provenance : il n'est nulle part", () => {
    const res = buildItemRows({
      ...RESOLVE,
      events: [],
      slot: 2,
      catalogue: CATALOGUE,
      includeMissing: true,
    });
    expect(res.rows.every((r) => r.sources.length === 0)).toBe(true);
  });
});

describe('filtre « sans provenance »', () => {
  const build = (events: ReturnType<typeof item>[]) =>
    buildItemRows({ ...RESOLVE, events, slot: 2, catalogue: CATALOGUE, includeMissing: true }).rows;

  it('retient un objet accorde par le serveur', () => {
    const rows = build([
      item({ itemId: 100, srcSlot: 1, locationId: 10 }),
      item({ itemId: 101, srcSlot: null, locationId: -1 }),
    ]);
    const view = filterItemRows(rows, { text: '', status: 'unknown', limit: 100 });
    expect(view.rows.map((r) => r.name)).toEqual(['Bombos']);
  });

  it("retient un objet dont le monde d'origine n'a pas de catalogue", () => {
    const rows = build([item({ itemId: 102, srcSlot: 7, locationId: 42 })]);
    expect(filterItemRows(rows, { text: '', status: 'unknown', limit: 100 }).rows.map((r) => r.name)).toEqual([
      'Hookshot',
    ]);
  });

  it("n'y verse jamais le catalogue, qui n'a de provenance nulle part", () => {
    const rows = build([item({ itemId: 100, srcSlot: 1, locationId: 10 })]);
    expect(rows.some((r) => r.status === 'missing')).toBe(true);
    const view = filterItemRows(rows, { text: '', status: 'unknown', limit: 100 });
    expect(view.rows).toEqual([]);
    expect(view.catalogueWithheld).toBe(false);
  });

  it('un objet dont tous les exemplaires sont expliques n’y figure pas', () => {
    const rows = build([
      item({ itemId: 100, srcSlot: 1, locationId: 10 }),
      item({ itemId: 100, srcSlot: 3, locationId: 1010 }),
    ]);
    expect(filterItemRows(rows, { text: '', status: 'unknown', limit: 100 }).rows).toEqual([]);
  });

  it('un seul exemplaire inexplique suffit a retenir la ligne', () => {
    const rows = build([
      item({ itemId: 100, srcSlot: 1, locationId: 10 }),
      item({ itemId: 100, srcSlot: null, locationId: -1 }),
    ]);
    expect(filterItemRows(rows, { text: '', status: 'unknown', limit: 100 }).rows.map((r) => r.name)).toEqual([
      'Progressive Sword',
    ]);
  });

  it('le filtre texte s’applique aussi a cette vue', () => {
    const rows = build([
      item({ itemId: 100, srcSlot: null, locationId: -1 }),
      item({ itemId: 101, srcSlot: null, locationId: -1 }),
    ]);
    expect(filterItemRows(rows, { text: 'bomb', status: 'unknown', limit: 100 }).rows.map((r) => r.name)).toEqual([
      'Bombos',
    ]);
  });
});

describe('filtre texte sur le joueur et l’emplacement', () => {
  const rows = buildItemRows({
    ...RESOLVE,
    events: [
      item({ itemId: 100, srcSlot: 1, locationId: 10 }),
      item({ itemId: 101, srcSlot: 3, locationId: 1010 }),
      hint({ itemId: 102, srcSlot: 1, locationId: 1020 }),
    ],
    slot: 2,
    catalogue: CATALOGUE,
    includeMissing: true,
  }).rows;

  const names = (text: string) =>
    filterItemRows(rows, { text, status: 'all', limit: 100 }).rows.map((r) => r.name);

  it('un nom de joueur retient ce qui vient de lui, recu comme hinte', () => {
    expect(names('zelda').sort()).toEqual(['Hookshot', 'Progressive Sword']);
    expect(names('mario')).toEqual(['Bombos']);
  });

  it("un nom d'emplacement retient l'objet qui en vient", () => {
    expect(names('mine lv')).toEqual(['Bombos']);
  });

  it("le nom de l'objet marche toujours, et le catalogue reste hors de « Tous »", () => {
    expect(names('hookshot')).toEqual(['Hookshot']);
    expect(names('moon')).toEqual([]);
  });
});
