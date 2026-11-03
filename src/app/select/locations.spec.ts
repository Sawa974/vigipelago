import { describe, expect, it } from 'vitest';
import type { ApEvent } from '../db/db';
import { buildLocationRows, filterLocationRows, type LocationRow } from './locations';

/** Cles de dedup au format reel : une cle simplifiee ne testerait pas l'idempotence. */
function check(part: Partial<ApEvent> & { locationId: number }): ApEvent {
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
    itemFlags: 0,
    text: '',
    segments: [],
    tags: null,
    sessionId: 1,
    raw: null,
    dedupKey: `i:0:${srcSlot}:${part.locationId}`,
    ...part,
  };
}

function hint(part: Partial<ApEvent> & { locationId: number }): ApEvent {
  return check({ ...part, kind: 'hint', dedupKey: `x:hint:${part.locationId.toString(16)}:28333333` });
}

/** Cinq noms au catalogue du jeu, quatre places par la seed (`total: 4`). */
const CATALOGUE: Record<number, string> = {
  10: 'Link Bedroom',
  11: 'Kings Tomb',
  12: 'Floodgate Chest',
  13: 'Spiral Cave',
  14: 'Mimic Cave',
};

function byName(rows: readonly LocationRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [r.name, r.status]));
}

const ITEM_CATALOGUES = new Map<number, Record<number, string>>([
  [1, { 500: 'Progressive Sword' }],
  [3, { 500: 'Prismatic Shard' }],
]);

const PLAYER_NAMES = new Map<number, string>([
  [1, 'Zelda'],
  [2, 'Dana'],
  [3, 'Mario'],
]);

const BASE = {
  catalogue: CATALOGUE,
  total: 4,
  checkedFromServer: 2,
  includeMissing: true,
  itemCatalogues: ITEM_CATALOGUES,
  playerNames: PLAYER_NAMES,
};

describe('buildLocationRows', () => {
  it('ne retient que les emplacements du monde de ce slot', () => {
    const res = buildLocationRows({
      ...BASE,
      events: [check({ locationId: 10, srcSlot: 2 }), check({ locationId: 11, srcSlot: 3 })],
      slot: 2,
      checkedFromServer: 1,
    });
    expect(res.rows.filter((r) => r.status === 'checked').map((r) => r.name)).toEqual(['Link Bedroom']);
  });

  it('un X/Y exact, et un reste exact, meme quand la liste des restants deborde', () => {
    const res = buildLocationRows({
      ...BASE,
      events: [check({ locationId: 10 }), check({ locationId: 11 }), hint({ locationId: 12 })],
      slot: 2,
    });

    expect(byName(res.rows)).toEqual({
      'Link Bedroom': 'checked',
      'Kings Tomb': 'checked',
      'Floodgate Chest': 'hinted',
      'Spiral Cave': 'missing',
      'Mimic Cave': 'missing',
    });

    expect(res.tally.total).toBe(4);
    expect(res.tally.remaining).toBe(2);
    expect(res.tally.ratio).toBe(0.5);
    expect(res.rows.filter((r) => r.status === 'missing' || r.status === 'hinted')).toHaveLength(3);
    expect(res.tally.catalogueSize).toBe(5);
  });

  it('signale les checks comptes que le journal ne sait pas nommer', () => {
    const res = buildLocationRows({
      ...BASE,
      events: [check({ locationId: 10 })],
      slot: 2,
      checkedFromServer: 3,
    });
    expect(res.tally.named).toBe(1);
    expect(res.tally.fromServer).toBe(3);
    expect(res.tally.countedNotNamed).toBe(2);
    expect(res.tally.remaining).toBe(1);
    expect(res.tally.checked).toBe(3);
    expect(res.tally.ratio).toBe(res.tally.checked / res.tally.total!);
  });

  it('le journal en avance sur la derniere capture ne cree pas de checks negatifs', () => {
    const res = buildLocationRows({
      ...BASE,
      events: [10, 11, 12, 13].map((locationId) => check({ locationId })),
      slot: 2,
      checkedFromServer: 1,
    });
    expect(res.tally.named).toBe(4);
    expect(res.tally.countedNotNamed).toBe(0);
    expect(res.tally.remaining).toBe(0);
    expect(res.tally.ratio).toBe(1);
    expect(res.tally.checked).toBe(4);
    expect(res.tally.fromServer).toBe(1);
    expect(res.tally.ratio).toBe(res.tally.checked / res.tally.total!);
  });

  it('un slot sans aucun check a un ratio de zero, pas un ratio inconnu', () => {
    const res = buildLocationRows({ ...BASE, events: [], slot: 2, checkedFromServer: 0 });
    expect(res.tally.ratio).toBe(0);
    expect(res.tally.remaining).toBe(4);
    expect(res.tally.named).toBe(0);
  });

  it('sans capture du slot, pas de total donc pas de X/Y invente', () => {
    const res = buildLocationRows({
      ...BASE,
      events: [check({ locationId: 10 })],
      slot: 2,
      total: null,
      checkedFromServer: null,
    });
    expect(res.tally.total).toBeNull();
    expect(res.tally.remaining).toBeNull();
    expect(res.tally.ratio).toBeNull();
    expect(res.tally.countedNotNamed).toBe(0);
  });

  it('le snapshot complete la liste, sans inventer un instant', () => {
    const res = buildLocationRows({
      ...BASE,
      events: [check({ locationId: 10 })],
      slot: 2,
      snapshot: [10, 11],
    });
    const tomb = res.rows.find((r) => r.name === 'Kings Tomb')!;
    expect(tomb.status).toBe('checked');
    expect(tomb.lastTs).toBeNull();
    expect(tomb.approx).toBe(true);
    expect(res.rows.find((r) => r.name === 'Link Bedroom')!.approx).toBe(false);
  });

  it('un instant exact l’emporte sur l’encadrement d’un rattrapage', () => {
    const res = buildLocationRows({
      ...BASE,
      events: [
        check({ locationId: 10, tsPrecision: 'approx', ts: 1_700_000_000_000 }),
        check({ locationId: 10, tsPrecision: 'exact', ts: 1_700_000_060_000 }),
      ],
      slot: 2,
    });
    const row = res.rows.find((r) => r.id === 10)!;
    expect(row.approx).toBe(false);
    expect(row.lastTs).toBe(1_700_000_060_000);
    expect(res.rows.filter((r) => r.id === 10)).toHaveLength(1);
  });

  it('un hint honore depuis cesse d’etre un hint', () => {
    const res = buildLocationRows({
      ...BASE,
      events: [hint({ locationId: 10 }), check({ locationId: 10 })],
      slot: 2,
      checkedFromServer: 1,
    });
    expect(res.rows.find((r) => r.id === 10)!.status).toBe('checked');
    expect(res.tally.hinted).toBe(0);
  });

  it('omet le reste du catalogue pour un autre joueur, mais garde son avancement', () => {
    const res = buildLocationRows({
      ...BASE,
      events: [check({ locationId: 10 }), hint({ locationId: 12 })],
      slot: 2,
      includeMissing: false,
      checkedFromServer: 2,
    });
    expect(byName(res.rows)).toEqual({ 'Link Bedroom': 'checked', 'Floodgate Chest': 'hinted' });
    expect(res.tally.remaining).toBe(2);
    expect(res.tally.ratio).toBe(0.5);
  });

  it('sans DataPackage, les emplacements portent leur id et le catalogue est inconnu', () => {
    const res = buildLocationRows({
      ...BASE,
      events: [check({ locationId: 10 })],
      slot: 2,
      catalogue: null,
      checkedFromServer: 1,
    });
    expect(res.catalogueMissing).toBe(true);
    expect(res.tally.catalogueSize).toBeNull();
    expect(res.rows.map((r) => r.name)).toEqual(['Location 10']);
    expect(res.rows[0].unresolved).toBe(true);
    expect(res.tally.remaining).toBe(3);
  });
});

describe('filterLocationRows', () => {
  const rows = buildLocationRows({
    ...BASE,
    events: [check({ locationId: 10 }), hint({ locationId: 12 })],
    slot: 2,
  }).rows;

  it('« Tous » montre les faits et retient le catalogue', () => {
    const res = filterLocationRows(rows, { text: '', status: 'all', limit: 100 });
    expect(res.rows.map((r) => r.name)).toEqual(['Floodgate Chest', 'Link Bedroom']);
    expect(res.catalogueWithheld).toBe(true);
  });

  it('croise texte et statut', () => {
    expect(filterLocationRows(rows, { text: 'cave', status: 'missing', limit: 100 }).rows.map((r) => r.name)).toEqual([
      'Mimic Cave',
      'Spiral Cave',
    ]);
  });

  it('garde le total quand le plafond coupe', () => {
    const res = filterLocationRows(rows, { text: '', status: 'missing', limit: 1 });
    expect(res.rows).toHaveLength(1);
    expect(res.matched).toBe(3);
    expect(res.truncated).toBe(true);
  });
});

describe('contenu des emplacements', () => {
  it("dit l'objet et son destinataire, l'objet resolu dans le jeu du destinataire", () => {
    const res = buildLocationRows({
      ...BASE,
      events: [check({ locationId: 10, dstSlot: 3, itemId: 500 })],
      slot: 2,
    });
    const row = res.rows.find((r) => r.name === 'Link Bedroom')!;
    expect(row.content).toMatchObject({ dstName: 'Mario', itemName: 'Prismatic Shard' });
  });

  it('un hint dit aussi ce qui dort la : c’est tout son interet', () => {
    const res = buildLocationRows({
      ...BASE,
      events: [hint({ locationId: 12, dstSlot: 1, itemId: 500 })],
      slot: 2,
    });
    const row = res.rows.find((r) => r.name === 'Floodgate Chest')!;
    expect(row.status).toBe('hinted');
    expect(row.content).toMatchObject({ dstName: 'Zelda', itemName: 'Progressive Sword' });
  });

  it("un emplacement connu du seul snapshot n'a pas de contenu, et ne passe pas pour vide", () => {
    const res = buildLocationRows({
      ...BASE,
      events: [],
      slot: 2,
      snapshot: [11],
    });
    const row = res.rows.find((r) => r.name === 'Kings Tomb')!;
    expect(row.status).toBe('checked');
    expect(row.content).toBeNull();
  });

  it("le reste du catalogue n'a pas de contenu : la seed n'y a rien place", () => {
    const res = buildLocationRows({ ...BASE, events: [], slot: 2 });
    expect(res.rows.filter((r) => r.status === 'missing').every((r) => r.content === null)).toBe(true);
  });

  it("sans le catalogue du destinataire, l'objet porte son id et le signale", () => {
    const res = buildLocationRows({
      ...BASE,
      events: [check({ locationId: 10, dstSlot: 9, itemId: 777 })],
      slot: 2,
    });
    expect(res.rows.find((r) => r.name === 'Link Bedroom')!.content).toMatchObject({
      dstName: 'Slot 9',
      itemName: 'Item 777',
      itemUnresolved: true,
    });
  });

  it("un doublon de rattrapage n'efface pas le contenu deja nomme", () => {
    const res = buildLocationRows({
      ...BASE,
      events: [
        check({ locationId: 10, dstSlot: 3, itemId: 500 }),
        check({ locationId: 10, dstSlot: 3, itemId: 500, tsPrecision: 'approx', ts: 1_700_000_900_000 }),
      ],
      slot: 2,
    });
    expect(res.rows.find((r) => r.name === 'Link Bedroom')!.content?.itemName).toBe('Prismatic Shard');
  });
});

describe('filtre « sans objet »', () => {
  it('retient un check que seul le serveur a liste', () => {
    const rows = buildLocationRows({
      ...BASE,
      events: [check({ locationId: 10, dstSlot: 3, itemId: 500 })],
      slot: 2,
      snapshot: [10, 11],
    }).rows;
    expect(filterLocationRows(rows, { text: '', status: 'unknown', limit: 100 }).rows.map((r) => r.name)).toEqual([
      'Kings Tomb',
    ]);
  });

  it('un hint nomme toujours son objet : il n’est jamais un trou', () => {
    const rows = buildLocationRows({
      ...BASE,
      events: [hint({ locationId: 12, dstSlot: 1, itemId: 500 })],
      slot: 2,
    }).rows;
    expect(filterLocationRows(rows, { text: '', status: 'unknown', limit: 100 }).rows).toEqual([]);
  });

  it("n'y verse jamais le catalogue : un emplacement non fait n'a rien a contenir", () => {
    const rows = buildLocationRows({ ...BASE, events: [], slot: 2 }).rows;
    expect(rows.some((r) => r.status === 'missing')).toBe(true);
    expect(filterLocationRows(rows, { text: '', status: 'unknown', limit: 100 }).rows).toEqual([]);
  });
});

describe('filtre texte sur le joueur et l’objet', () => {
  const rows = buildLocationRows({
    ...BASE,
    events: [
      check({ locationId: 10, dstSlot: 3, itemId: 500 }),
      hint({ locationId: 12, dstSlot: 1, itemId: 500 }),
    ],
    slot: 2,
  }).rows;

  const names = (text: string) =>
    filterLocationRows(rows, { text, status: 'all', limit: 100 }).rows.map((r) => r.name);

  it('un nom de joueur retient ce qui lui est destine, check comme hinte', () => {
    expect(names('mario')).toEqual(['Link Bedroom']);
    expect(names('zelda')).toEqual(['Floodgate Chest']);
  });

  it("un nom d'objet retient l'emplacement qui le contenait", () => {
    expect(names('prismatic')).toEqual(['Link Bedroom']);
    expect(names('progressive')).toEqual(['Floodgate Chest']);
  });
});
