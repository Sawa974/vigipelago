import type { ApEvent } from '../db/db';
import { itemClassOf, type ItemClass } from '../protocol/item-class';
import { filterChecklist, type ChecklistView } from './checklist';

/** Le nombre restant est exact ; la liste des restants vient du catalogue du jeu et deborde. */
export type LocationStatus = 'checked' | 'hinted' | 'missing';

/** L'objet se nomme dans le jeu du destinataire, pas du monde qui l'heberge. */
export interface LocationContent {
  dstSlot: number;
  dstName: string;
  itemId: number;
  itemName: string;
  itemUnresolved: boolean;
  cls: ItemClass | 'unknown';
}

export interface LocationRow {
  id: number;
  name: string;
  status: LocationStatus;
  unresolved: boolean;
  lastTs: number | null;
  approx: boolean;
  searchExtra: string;
  /** `null` : fait sans qu'aucun evenement nomme l'objet, un trou et non un emplacement vide. */
  content: LocationContent | null;
}

export interface LocationTally {
  named: number;
  /** Le numerateur du ratio : aucun gabarit ne doit le recomposer. */
  checked: number;
  fromServer: number | null;
  countedNotNamed: number;
  hinted: number;
  total: number | null;
  remaining: number | null;
  /** De 0 a 1 ; `null` sans total. */
  ratio: number | null;
  catalogueSize: number | null;
}

export interface LocationRowsInput {
  events: readonly ApEvent[];
  slot: number;
  /** Notre slot seulement : `db.snapshots` n'est ecrit qu'au `Connected`. */
  snapshot?: readonly number[] | null;
  catalogue: Record<number, string> | null;
  total: number | null;
  checkedFromServer: number | null;
  /** Faux pour les autres joueurs : spoiler. */
  includeMissing: boolean;
  /** Par slot destinataire, le catalogue de SON jeu. */
  itemCatalogues: ReadonlyMap<number, Record<number, string>>;
  playerNames: ReadonlyMap<number, string>;
}

export interface LocationRowsResult {
  rows: LocationRow[];
  tally: LocationTally;
  catalogueMissing: boolean;
}

export function buildLocationRows(input: LocationRowsInput): LocationRowsResult {
  const {
    events,
    slot,
    snapshot,
    catalogue,
    total,
    checkedFromServer,
    includeMissing,
    itemCatalogues,
    playerNames,
  } = input;

  const checkedTs = new Map<number, { ts: number; approx: boolean }>();
  const hinted = new Set<number>();
  const content = new Map<number, LocationContent>();

  const contentOf = (e: ApEvent): LocationContent | null => {
    if (e.itemId === null || e.dstSlot === null) return null;
    const table = itemCatalogues.get(e.dstSlot) ?? null;
    return {
      dstSlot: e.dstSlot,
      dstName: playerNames.get(e.dstSlot) ?? `Slot ${e.dstSlot}`,
      itemId: e.itemId,
      itemName: table?.[e.itemId] ?? `Objet ${e.itemId}`,
      itemUnresolved: table?.[e.itemId] === undefined,
      cls: e.itemFlags === null ? 'unknown' : (itemClassOf(e.itemFlags) ?? 'unknown'),
    };
  };

  for (const e of events) {
    if (e.locationId === null || e.srcSlot !== slot) continue;
    if (e.kind === 'item') {
      const prev = checkedTs.get(e.locationId);
      // L'instant exact l'emporte sur un encadrement.
      if (!prev || (prev.approx && e.tsPrecision === 'exact')) {
        checkedTs.set(e.locationId, { ts: e.ts, approx: e.tsPrecision === 'approx' });
      }
      const c = contentOf(e);
      if (c && !content.has(e.locationId)) content.set(e.locationId, c);
    } else if (e.kind === 'hint') {
      hinted.add(e.locationId);
      const c = contentOf(e);
      if (c && !content.has(e.locationId)) content.set(e.locationId, c);
    }
  }
  // `ts: 0` marque un fait sans instant, rendu `lastTs: null` plus bas.
  for (const id of snapshot ?? []) {
    if (!checkedTs.has(id)) checkedTs.set(id, { ts: 0, approx: true });
  }

  const rows: LocationRow[] = [];
  const extraOf = (c: LocationContent | null): string => (c ? `${c.dstName} ${c.itemName}` : '');

  for (const [id, when] of checkedTs) {
    rows.push({
      id,
      name: nameOf(catalogue, id),
      status: 'checked',
      unresolved: catalogue?.[id] === undefined,
      lastTs: when.ts === 0 ? null : when.ts,
      approx: when.approx,
      searchExtra: extraOf(content.get(id) ?? null),
      content: content.get(id) ?? null,
    });
  }

  for (const id of hinted) {
    if (checkedTs.has(id)) continue;
    rows.push({
      id,
      name: nameOf(catalogue, id),
      status: 'hinted',
      unresolved: catalogue?.[id] === undefined,
      lastTs: null,
      approx: false,
      searchExtra: extraOf(content.get(id) ?? null),
      content: content.get(id) ?? null,
    });
  }

  if (includeMissing && catalogue) {
    for (const [key, name] of Object.entries(catalogue)) {
      const id = Number(key);
      if (checkedTs.has(id) || hinted.has(id)) continue;
      rows.push({
        id,
        name,
        status: 'missing',
        unresolved: false,
        lastTs: null,
        approx: false,
        searchExtra: '',
        content: null,
      });
    }
  }

  rows.sort(
    (a, b) =>
      Number(a.unresolved) - Number(b.unresolved) ||
      a.name.localeCompare(b.name, 'fr', { numeric: true }) ||
      a.id - b.id,
  );

  const named = checkedTs.size;
  // Meme convention que `buildProgress` : les deux ecrans doivent s'accorder.
  const checked = Math.max(named, checkedFromServer ?? 0);
  // Bornee : une capture peut etre plus vieille que le journal.
  const remaining = total === null ? null : Math.max(0, total - Math.min(checked, total));

  return {
    rows,
    tally: {
      named,
      checked,
      fromServer: checkedFromServer,
      countedNotNamed: Math.max(0, (checkedFromServer ?? 0) - named),
      hinted: rows.reduce((n, r) => n + (r.status === 'hinted' ? 1 : 0), 0),
      total,
      remaining,
      ratio: total ? Math.min(1, checked / total) : null,
      catalogueSize: catalogue ? Object.keys(catalogue).length : null,
    },
    catalogueMissing: catalogue === null,
  };
}

function nameOf(catalogue: Record<number, string> | null, id: number): string {
  return catalogue?.[id] ?? `Emplacement ${id}`;
}

export function contentUnknown(row: LocationRow): boolean {
  return row.status === 'checked' && row.content === null;
}

export type LocationFilter = LocationStatus | 'all' | 'unknown';

export type LocationView<R = LocationRow> = ChecklistView<R>;

export function filterLocationRows<R extends LocationRow>(
  rows: readonly R[],
  opts: { text: string; status: LocationFilter; limit: number },
): LocationView<R> {
  if (opts.status === 'unknown') {
    const holes = rows.filter(contentUnknown);
    // Parametres explicites : sans `withheld`, l'inference reduirait `S` a `'all'`.
    return filterChecklist<LocationStatus, R>(holes, {
      text: opts.text,
      status: 'all',
      limit: opts.limit,
    });
  }
  return filterChecklist(rows, { ...opts, status: opts.status, withheld: 'missing' });
}
