import type { ApEvent } from '../db/db';
import { itemClassOf, type ItemClass } from '../protocol/item-class';
import { filterChecklist, type ChecklistView } from './checklist';
import { DEFAULT_FALLBACK_NAMES, type FallbackNames } from './fallback-names';

/** `missing` vient du catalogue du jeu, pas de la seed : une borne large, jamais un X/Y. */
export type ItemStatus = 'received' | 'hinted' | 'missing';

/** L'emplacement se nomme dans le jeu du monde d'origine, pas du destinataire. */
export interface ItemSource {
  /** `null` pour un objet accorde sans emplacement (location negative). */
  slot: number | null;
  playerName: string | null;
  locationId: number | null;
  locationName: string | null;
  unresolved: boolean;
  ts: number;
  approx: boolean;
}

export interface ItemRow {
  id: number;
  name: string;
  status: ItemStatus;
  /** Un objet progressif arrive plusieurs fois sous le meme id. */
  count: number;
  unresolved: boolean;
  /** `null` pour un objet jamais vu passer, distinct de `'unknown'`. */
  cls: ItemClass | 'unknown' | null;
  lastTs: number | null;
  searchExtra: string;
  /** La plus recente d'abord. */
  sources: ItemSource[];
}

export interface ItemTally {
  received: number;
  hinted: number;
  /** `null` sans catalogue, pas zero. */
  missing: number | null;
  /** Doublons compris, contrairement a `received`. */
  copies: number;
}

export interface ItemRowsInput {
  events: readonly ApEvent[];
  slot: number;
  catalogue: Record<number, string> | null;
  /** Faux pour les autres joueurs : leur reste du catalogue serait du spoiler. */
  includeMissing: boolean;
  /** Par slot, le catalogue de SON jeu : un emplacement se nomme chez lui. */
  locationCatalogues: ReadonlyMap<number, Record<number, string>>;
  playerNames: ReadonlyMap<number, string>;
  /** Absent : les noms par defaut, en anglais. */
  fallback?: FallbackNames;
}

export interface ItemRowsResult {
  rows: ItemRow[];
  tally: ItemTally;
  catalogueMissing: boolean;
}

export function buildItemRows(input: ItemRowsInput): ItemRowsResult {
  const { events, slot, catalogue, includeMissing, locationCatalogues, playerNames } = input;
  const fallback = input.fallback ?? DEFAULT_FALLBACK_NAMES;

  const counts = new Map<number, number>();
  const flags = new Map<number, number | null>();
  const lastTs = new Map<number, number>();
  const hinted = new Set<number>();
  const sources = new Map<number, ItemSource[]>();
  const hintSources = new Map<number, ItemSource[]>();

  const sourceOf = (e: ApEvent): ItemSource => {
    // Seuil `< 0` identique a decode.ts et received-items.ts : les trois doivent concorder.
    const placed = e.srcSlot !== null && e.locationId !== null && e.locationId >= 0;
    const table = placed ? locationCatalogues.get(e.srcSlot!) : undefined;
    return {
      slot: placed ? e.srcSlot : null,
      playerName: placed ? (playerNames.get(e.srcSlot!) ?? fallback.slot(e.srcSlot!)) : null,
      locationId: placed ? e.locationId : null,
      locationName: placed ? (table?.[e.locationId!] ?? fallback.location(e.locationId!)) : null,
      unresolved: placed ? table?.[e.locationId!] === undefined : false,
      ts: e.ts,
      approx: e.tsPrecision === 'approx',
    };
  };

  const add = (map: Map<number, ItemSource[]>, id: number, src: ItemSource) => {
    const list = map.get(id);
    if (list) list.push(src);
    else map.set(id, [src]);
  };

  for (const e of events) {
    if (e.itemId === null || e.dstSlot !== slot) continue;
    if (e.kind === 'item') {
      counts.set(e.itemId, (counts.get(e.itemId) ?? 0) + 1);
      // Le premier exemplaire resolu fait foi : un rattrapage sans flags ne l'ecrase pas.
      if (flags.get(e.itemId) == null) flags.set(e.itemId, e.itemFlags);
      lastTs.set(e.itemId, Math.max(lastTs.get(e.itemId) ?? 0, e.ts));
      add(sources, e.itemId, sourceOf(e));
    } else if (e.kind === 'hint') {
      hinted.add(e.itemId);
      if (!flags.has(e.itemId)) flags.set(e.itemId, e.itemFlags);
      add(hintSources, e.itemId, sourceOf(e));
    }
  }

  const recentFirst = (list: ItemSource[]) => [...list].sort((a, b) => b.ts - a.ts);

  const extraOf = (list: readonly ItemSource[]): string => {
    const seen = new Set<string>();
    for (const s of list) {
      if (s.playerName) seen.add(s.playerName);
      if (s.locationName) seen.add(s.locationName);
    }
    return [...seen].join(' ');
  };

  const rows: ItemRow[] = [];
  let copies = 0;

  for (const [id, count] of counts) {
    copies += count;
    rows.push({
      id,
      name: nameOf(catalogue, id, fallback),
      status: 'received',
      count,
      unresolved: catalogue?.[id] === undefined,
      cls: classOf(flags.get(id)),
      lastTs: lastTs.get(id) ?? null,
      searchExtra: extraOf(sources.get(id) ?? []),
      sources: recentFirst(sources.get(id) ?? []),
    });
  }

  for (const id of hinted) {
    if (counts.has(id)) continue;
    rows.push({
      id,
      name: nameOf(catalogue, id, fallback),
      status: 'hinted',
      count: 0,
      unresolved: catalogue?.[id] === undefined,
      cls: classOf(flags.get(id)),
      lastTs: null,
      searchExtra: extraOf(hintSources.get(id) ?? []),
      sources: recentFirst(hintSources.get(id) ?? []),
    });
  }

  if (includeMissing && catalogue) {
    for (const [key, name] of Object.entries(catalogue)) {
      const id = Number(key);
      if (counts.has(id) || hinted.has(id)) continue;
      rows.push({
        id,
        name,
        status: 'missing',
        count: 0,
        unresolved: false,
        cls: null,
        lastTs: null,
        searchExtra: '',
        sources: [],
      });
    }
  }

  rows.sort(
    (a, b) =>
      Number(a.unresolved) - Number(b.unresolved) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }) ||
      a.id - b.id,
  );

  const hintedRows = rows.filter((r) => r.status === 'hinted');
  // Ne soustraire que les ids du catalogue, sinon le reste passe sous le vrai.
  const knownReceived = catalogue ? [...counts.keys()].filter((id) => catalogue[id] !== undefined).length : 0;
  const knownHinted = catalogue ? hintedRows.filter((r) => !r.unresolved).length : 0;
  return {
    rows,
    tally: {
      received: counts.size,
      hinted: hintedRows.length,
      missing: catalogue ? Object.keys(catalogue).length - knownReceived - knownHinted : null,
      copies,
    },
    catalogueMissing: catalogue === null,
  };
}

function nameOf(catalogue: Record<number, string> | null, id: number, fallback: FallbackNames): string {
  return catalogue?.[id] ?? fallback.item(id);
}

function classOf(f: number | null | undefined): ItemClass | 'unknown' | null {
  if (f === undefined) return null;
  return itemClassOf(f) ?? 'unknown';
}

export function sourceUnknown(row: ItemRow): boolean {
  return row.sources.some((s) => s.slot === null || s.unresolved);
}

/** `unknown` traverse les trois statuts, d'ou son traitement hors `filterChecklist`. */
export type ItemFilter = ItemStatus | 'all' | 'unknown';

export type FilterResult<R = ItemRow> = ChecklistView<R>;

// Generique : fixe a `ItemRow`, les champs en plus des lignes disparaitraient du type.
export function filterItemRows<R extends ItemRow>(
  rows: readonly R[],
  opts: { text: string; status: ItemFilter; limit: number },
): FilterResult<R> {
  if (opts.status === 'unknown') {
    // Sans le reste du catalogue, qui repondrait entier.
    const holes = rows.filter((r) => r.status !== 'missing' && sourceUnknown(r));
    // Parametres explicites : sans `withheld`, l'inference reduirait `S` a `'all'`.
    return filterChecklist<ItemStatus, R>(holes, { text: opts.text, status: 'all', limit: opts.limit });
  }
  return filterChecklist(rows, { ...opts, status: opts.status, withheld: 'missing' });
}
