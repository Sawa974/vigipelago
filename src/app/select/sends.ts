import type { ApEvent } from '../db/db';
import { itemClassOf, type ItemClass } from '../protocol/item-class';
import { filterChecklist, type ChecklistView } from './checklist';

/** Un objet se nomme dans le jeu du destinataire, pas dans celui du monde qui l'heberge. */
export type SendStatus = 'sent' | 'pending';

export interface SendRow {
  /** Identifie la ligne : un emplacement n'est check qu'une fois. */
  locationId: number;
  name: string;
  searchExtra: string;
  status: SendStatus;
  itemId: number;
  /** Resolu dans le jeu du DESTINATAIRE. */
  itemName: string;
  dstSlot: number;
  dstName: string;
  toSelf: boolean;
  cls: ItemClass | 'unknown';
  /** Instant du hint pour une ligne `pending`. */
  ts: number;
  approx: boolean;
  unresolved: boolean;
  itemUnresolved: boolean;
}

export interface SendTally {
  sent: number;
  toOthers: number;
  toSelf: number;
  pending: number;
  /** Envois reels absents de la liste : a afficher. */
  doneWithoutItem: number;
}

export interface SendRowsInput {
  events: readonly ApEvent[];
  slot: number;
  /** Tait un hint deja honore dont l'envoi n'a pas ete vu. */
  snapshot?: readonly number[] | null;
  /** Existe pour tous les slots balayes, le snapshot pour le notre seulement. */
  checkedFromServer?: number | null;
  locationCatalogue: Record<number, string> | null;
  /** Par slot destinataire, le catalogue de SON jeu. */
  itemCatalogues: ReadonlyMap<number, Record<number, string>>;
  playerNames: ReadonlyMap<number, string>;
}

export interface SendRowsResult {
  rows: SendRow[];
  tally: SendTally;
  catalogueMissing: boolean;
  itemCataloguesMissing: string[];
}

interface Hit {
  itemId: number;
  dstSlot: number;
  flags: number | null;
  ts: number;
  approx: boolean;
}

export function buildSendRows(input: SendRowsInput): SendRowsResult {
  const { events, slot, snapshot, locationCatalogue, itemCatalogues, playerNames } = input;
  const checkedFromServer = input.checkedFromServer ?? null;

  const sent = new Map<number, Hit>();
  const hints = new Map<number, Hit>();

  for (const e of events) {
    // Location negative : objet injecte par la console ou le serveur, pas un envoi.
    if (e.srcSlot !== slot || e.locationId === null || e.locationId < 0) continue;
    if (e.itemId === null || e.dstSlot === null) continue;
    const hit: Hit = {
      itemId: e.itemId,
      dstSlot: e.dstSlot,
      flags: e.itemFlags,
      ts: e.ts,
      approx: e.tsPrecision === 'approx',
    };
    if (e.kind === 'item') {
      const prev = sent.get(e.locationId);
      // L'instant exact l'emporte sur un encadrement.
      if (!prev || (prev.approx && !hit.approx)) sent.set(e.locationId, hit);
    } else if (e.kind === 'hint' && !hints.has(e.locationId)) {
      hints.set(e.locationId, hit);
    }
  }

  const done = new Set<number>(snapshot ?? []);
  const rows: SendRow[] = [];
  let toOthers = 0;
  let toSelf = 0;
  let pending = 0;

  const push = (locationId: number, hit: Hit, status: SendStatus): void => {
    const catalogue = itemCatalogues.get(hit.dstSlot) ?? null;
    const toItsHost = hit.dstSlot === slot;
    const dstName = playerNames.get(hit.dstSlot) ?? `Slot ${hit.dstSlot}`;
    const itemName = catalogue?.[hit.itemId] ?? `Objet ${hit.itemId}`;
    rows.push({
      locationId,
      name: locationCatalogue?.[locationId] ?? `Emplacement ${locationId}`,
      searchExtra: `${itemName} ${dstName}`,
      status,
      itemId: hit.itemId,
      itemName,
      dstSlot: hit.dstSlot,
      dstName,
      toSelf: toItsHost,
      cls: hit.flags === null ? 'unknown' : (itemClassOf(hit.flags) ?? 'unknown'),
      ts: hit.ts,
      approx: hit.approx,
      unresolved: locationCatalogue?.[locationId] === undefined,
      itemUnresolved: catalogue?.[hit.itemId] === undefined,
    });
    if (status === 'pending') pending++;
    else if (toItsHost) toSelf++;
    else toOthers++;
  };

  for (const [locationId, hit] of sent) push(locationId, hit, 'sent');

  for (const [locationId, hit] of hints) {
    if (sent.has(locationId) || done.has(locationId)) continue;
    push(locationId, hit, 'pending');
  }

  // Le plus recent d'abord : le plafond doit couper les plus vieilles lignes.
  rows.sort(
    (a, b) => b.ts - a.ts || a.name.localeCompare(b.name, 'fr', { numeric: true }),
  );

  const missing = new Set<string>();
  for (const r of rows) {
    if (!itemCatalogues.has(r.dstSlot)) missing.add(r.dstName);
  }

  // Deux bornes basses du meme ecart, aucune ne contient l'autre : le max, pas la somme.
  let unnamedFromSnapshot = 0;
  for (const id of done) if (!sent.has(id)) unnamedFromSnapshot++;
  const doneWithoutItem = Math.max(
    unnamedFromSnapshot,
    checkedFromServer === null ? 0 : checkedFromServer - sent.size,
    0,
  );

  return {
    rows,
    tally: { sent: sent.size, toOthers, toSelf, pending, doneWithoutItem },
    catalogueMissing: locationCatalogue === null,
    itemCataloguesMissing: [...missing].sort((a, b) => a.localeCompare(b, 'fr')),
  };
}

export type SendView<R = SendRow> = ChecklistView<R>;

export function filterSendRows<R extends SendRow>(
  rows: readonly R[],
  opts: { text: string; status: SendStatus | 'all'; limit: number },
): SendView<R> {
  return filterChecklist(rows, opts);
}
