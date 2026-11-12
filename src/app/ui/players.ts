import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import Dexie from 'dexie';
import { ApSessionService, type SlotPresenceView } from '../core/ap-session.service';
import { db, type ApEvent, type CachedGamePackage } from '../db/db';
import { ITEM_CLASS_GLYPH, ITEM_CLASS_LABEL, type ItemClass } from '../protocol/item-class';
import { I18n } from '../i18n/i18n.service';
import type { Key } from '../i18n/en';
import {
  buildItemRows,
  filterItemRows,
  sourceUnknown,
  type ItemFilter,
  type ItemRow,
  type ItemSource,
} from '../select/items';
import {
  buildLocationRows,
  contentUnknown,
  filterLocationRows,
  type LocationFilter,
} from '../select/locations';
import { DEATH_KNOWLEDGE_LABEL, buildDeathTally } from '../select/deaths';
import { isGoalReached, resolveSlotStatus } from '../ingest/client-status';
import { FLOW_ROW_LIMIT, buildFlows, type FlowRow } from '../select/flows';
import { classSegments, countEvents } from '../select/progress';
import { shortStamp } from '../select/stamp';
import { buildHintEconomy } from '../select/hint-economy';
import { buildSendRows, filterSendRows, type SendStatus } from '../select/sends';
import { fallbackNames } from '../select/fallback-names';
import { usesTwelveHours } from '../select/date-format';
import { truncPercent } from '../select/percent';

const RELOAD_THROTTLE_MS = 15_000;

const ITEM_ROW_LIMIT = 1000;

type PresenceKind = SlotPresenceView['state'] | 'none';

interface RosterRow {
  slot: number;
  name: string;
  game: string;
  self: boolean;
  presence: PresenceKind;
  textClient: boolean;
}

/** « Tous » ne couvre que les faits, jamais le catalogue du jeu. */
const ITEM_FILTERS: { key: ItemFilter; label: Key; title: Key }[] = [
  { key: 'all', label: 'pf.all', title: 'pf.items.all.title' },
  { key: 'received', label: 'pf.received', title: 'pf.received.title' },
  { key: 'hinted', label: 'pf.hint', title: 'pf.items.hinted.title' },
  { key: 'missing', label: 'pf.notReceived', title: 'pf.notReceived.title' },
  // Un trou et non un statut : il traverse les trois autres au lieu de s'y ajouter.
  { key: 'unknown', label: 'pf.unknown', title: 'pf.items.unknown.title' },
];

const LOCATION_FILTERS: { key: LocationFilter; label: Key; title: Key }[] = [
  { key: 'all', label: 'pf.all', title: 'pf.locs.all.title' },
  { key: 'checked', label: 'pf.check', title: 'pf.check.title' },
  { key: 'hinted', label: 'pf.hint', title: 'pf.locs.hinted.title' },
  { key: 'missing', label: 'pf.notChecked', title: 'pf.notChecked.title' },
  { key: 'unknown', label: 'pf.unknown', title: 'pf.locs.unknown.title' },
];

const SEND_FILTERS: { key: SendStatus | 'all'; label: Key; title: Key }[] = [
  { key: 'all', label: 'pf.all', title: 'pf.send.all.title' },
  { key: 'sent', label: 'pf.sent', title: 'pf.sent.title' },
  { key: 'pending', label: 'pf.hint', title: 'pf.pending.title' },
];

@Component({
  selector: 'app-players',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './players.html',
  styleUrl: './players.css',
  host: { '[class.h12]': 'twelveHours()' },
})
export class PlayersTab {
  protected readonly ap = inject(ApSessionService);
  private readonly i18n = inject(I18n);
  protected readonly t = this.i18n.t;
  /** `~09:05 PM` deborde les colonnes taillees pour `~21:05`. */
  protected readonly twelveHours = computed(() => usesTwelveHours(this.i18n.dateStyle()));
  /** Relu a chaque changement de langue. */
  private readonly fallback = computed(() => (this.i18n.lang(), fallbackNames(this.t)));

  protected readonly selected = signal<number | null>(null);
  protected readonly loading = signal(false);
  protected readonly rowLimit = ITEM_ROW_LIMIT;
  protected readonly pct = truncPercent;

  protected readonly text = signal('');
  protected readonly status = signal<ItemFilter>('all');
  protected readonly locText = signal('');
  protected readonly locStatus = signal<LocationFilter>('all');
  /** Ici et non dans la ligne, reconstruite a chaque relecture du journal. */
  private readonly expanded = signal<ReadonlySet<number>>(new Set());
  protected readonly sendText = signal('');
  protected readonly sendStatus = signal<SendStatus | 'all'>('all');

  /** Objets destines au slot regarde, et hints le concernant. */
  private readonly inbound = signal<ApEvent[]>([]);
  /** Checks du slot regarde, et hints qui pointent dans son monde. */
  private readonly outbound = signal<ApEvent[]>([]);
  /** `null` si le DataPackage manque. */
  private readonly catalogue = signal<Record<number, string> | null>(null);
  private readonly locCatalogue = signal<Record<number, string> | null>(null);
  /** Par slot : un objet place dans ce monde se nomme dans le jeu de son destinataire. */
  private readonly itemCatalogues = signal<ReadonlyMap<number, Record<number, string>>>(new Map());
  /** Par slot : l'emplacement d'un objet recu appartient au monde d'origine. */
  private readonly locCatalogues = signal<ReadonlyMap<number, Record<number, string>>>(new Map());
  private readonly slotStatusStored = signal<number | null>(null);
  private readonly totalLocations = signal<number | null>(null);
  private readonly checkedFromServer = signal<number | null>(null);
  private readonly slotHintPoints = signal<number | null>(null);
  private readonly slotHintCostObserved = signal<number | null>(null);
  private readonly slotHintCostObservedFor = signal<number | null>(null);
  private readonly roomHintCost = signal<number | null>(null);
  private readonly roomCheckPoints = signal<number | null>(null);
  /** Ecrit au `Connected` pour notre slot, au balayage reussi pour les autres. */
  private readonly snapshot = signal<number[] | null>(null);
  private readonly loadedAt = signal(0);
  private readonly loadedSlot = signal<number | null>(null);

  protected readonly roster = computed<RosterRow[]>(() => {
    const own = this.ap.ownSlot();
    const presence = this.ap.presence();
    return this.ap
      .players()
      .map((p) => ({
        slot: p.slot,
        name: p.name,
        game: p.game,
        self: p.slot === own,
        presence: (presence[p.slot]?.state ?? 'none') as PresenceKind,
        textClient: presence[p.slot]?.textClient ?? false,
      }))
      .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
  });

  private readonly playerNames = computed(() => new Map(this.roster().map((r) => [r.slot, r.name])));

  protected readonly current = computed<RosterRow | null>(() => {
    const slot = this.selected();
    return this.roster().find((r) => r.slot === slot) ?? null;
  });

  /** « Non recu » et « Non check » seulement sur son propre slot : ailleurs, c'est du spoiler. */
  protected readonly ownSlotSelected = computed(
    () => this.selected() !== null && this.selected() === this.ap.ownSlot(),
  );

  /** Comptees avec les predicats du filtre lui-meme, pour que les deux s'accordent. */
  protected readonly unknownItems = computed(
    () => this.built().rows.filter((r) => r.status !== 'missing' && sourceUnknown(r)).length,
  );
  protected readonly unknownLocs = computed(() => this.locBuilt().rows.filter(contentUnknown).length);

  protected readonly statusFilters = computed(() =>
    ITEM_FILTERS.filter(
      (f) =>
        (f.key !== 'missing' || this.ownSlotSelected()) && (f.key !== 'unknown' || this.unknownItems() > 0),
    ),
  );

  protected readonly locStatusFilters = computed(() =>
    LOCATION_FILTERS.filter(
      (f) =>
        (f.key !== 'missing' || this.ownSlotSelected()) && (f.key !== 'unknown' || this.unknownLocs() > 0),
    ),
  );

  private readonly built = computed(() => {
    const slot = this.loadedSlot();
    if (slot === null) {
      return { rows: [], tally: { received: 0, hinted: 0, missing: null, copies: 0 }, catalogueMissing: true };
    }
    return buildItemRows({
      events: this.inbound(),
      slot,
      catalogue: this.catalogue(),
      includeMissing: slot === this.ap.ownSlot(),
      locationCatalogues: this.locCatalogues(),
      playerNames: this.playerNames(),
      fallback: this.fallback(),
    });
  });

  protected readonly tally = computed(() => this.built().tally);
  protected readonly catalogueMissing = computed(() => this.built().catalogueMissing);

  protected readonly view = computed(() =>
    filterItemRows(this.built().rows, {
      text: this.text(),
      status: this.status(),
      limit: ITEM_ROW_LIMIT,
    }),
  );

  private readonly locBuilt = computed(() => {
    const slot = this.loadedSlot();
    return buildLocationRows({
      events: slot === null ? [] : this.outbound(),
      slot: slot ?? -1,
      snapshot: this.snapshot(),
      catalogue: this.locCatalogue(),
      total: this.totalLocations(),
      checkedFromServer: this.checkedFromServer(),
      includeMissing: slot !== null && slot === this.ap.ownSlot(),
      itemCatalogues: this.itemCatalogues(),
      playerNames: this.playerNames(),
      fallback: this.fallback(),
    });
  });

  protected readonly locTally = computed(() => this.locBuilt().tally);

  protected readonly hintEconomy = computed(() => {
    // Deconnecte, `hintPoints` vaut 0, ce qui n'est pas un solde.
    const live =
      this.ownSlotSelected() && this.ap.state() === 'online' ? this.ap.hintPoints() : null;
    // Une observation de cette seance n'est pas encore relue en base.
    const observed = this.ownSlotSelected()
      ? (this.ap.hintCostObserved() ?? this.slotHintCostObserved())
      : this.slotHintCostObserved();
    const observedFor =
      this.ownSlotSelected() && this.ap.hintCostObserved() !== null
        ? this.roomHintCost()
        : this.slotHintCostObservedFor();
    return buildHintEconomy({
      hintCost: this.roomHintCost(),
      locationCheckPoints: this.roomCheckPoints(),
      totalLocations: this.locTally().total,
      checked: this.locTally().checked,
      hintPoints: live ?? this.slotHintPoints(),
      observedCost: observed,
      observedFor,
    });
  });

  protected readonly locCatalogueMissing = computed(() => this.locBuilt().catalogueMissing);

  protected readonly locView = computed(() =>
    filterLocationRows(this.locBuilt().rows, {
      text: this.locText(),
      status: this.locStatus(),
      limit: ITEM_ROW_LIMIT,
    }),
  );

  /** Pas de `includeMissing` : aucun catalogue ne dit quels objets un monde contient. */
  private readonly sendBuilt = computed(() => {
    const slot = this.loadedSlot();
    return buildSendRows({
      events: slot === null ? [] : this.outbound(),
      slot: slot ?? -1,
      snapshot: this.snapshot(),
      checkedFromServer: this.checkedFromServer(),
      locationCatalogue: this.locCatalogue(),
      itemCatalogues: this.itemCatalogues(),
      playerNames: this.playerNames(),
      fallback: this.fallback(),
    });
  });

  protected readonly sendTally = computed(() => this.sendBuilt().tally);
  protected readonly sendCataloguesMissing = computed(() => this.sendBuilt().itemCataloguesMissing);

  protected readonly sendView = computed(() =>
    filterSendRows(this.sendBuilt().rows, {
      text: this.sendText(),
      status: this.sendStatus(),
      limit: ITEM_ROW_LIMIT,
    }),
  );

  protected readonly sendTitle = computed(() => {
    const p = this.current();
    if (!p) return this.t('pl.world.this');
    return p.self ? this.t('pl.world.mine') : this.t('pl.world.of', { name: p.name });
  });

  protected readonly sendStatusFilters = SEND_FILTERS;

  /** Morts et tags `join` arrivent dans `outbound`, attaches au slot par `srcSlot`. */
  protected readonly slotDeaths = computed(() => {
    const slot = this.selected();
    if (slot === null) return null;
    const tally = buildDeathTally({ events: this.outbound(), slots: [slot] });
    const row = tally.bySlot[0];
    return { ...row, why: this.t(DEATH_KNOWLEDGE_LABEL[row.knowledge]) };
  });

  protected readonly flows = computed(() => {
    const slot = this.selected();
    if (slot === null) return null;
    return buildFlows({
      slot,
      outbound: this.outbound(),
      inbound: this.inbound(),
      names: new Map(this.ap.players().map((p) => [p.slot, p.name])),
      fallback: this.fallback(),
    });
  });

  protected readonly flowRowLimit = FLOW_ROW_LIMIT;

  protected readonly hintBalanceFreshness = computed(() => {
    if (this.ownSlotSelected() && this.ap.state() === 'online') return this.t('tile.fresh.now');
    return this.t('tile.fresh.sweep');
  });

  /** Le catalogue du jeu deborde la seed : la liste des « non fait » n'est qu'une borne. */
  protected readonly locListOverhang = computed(() => {
    const t = this.locTally();
    if (t.catalogueSize === null || t.total === null) return null;
    const over = t.catalogueSize - t.total;
    return over > 0 ? over : null;
  });

  /* ---------- Bandeau de tuiles ---------- */

  protected readonly slotGoal = computed(() => {
    const slot = this.selected();
    if (slot === null) return { reached: false, status: null as number | null };
    const live = this.ap.slotStatus();
    const status = resolveSlotStatus(live, slot, this.slotStatusStored());
    return { reached: isGoalReached(status), status };
  });

  /** Vrai ou inconnu, jamais faux : un release n'est pas rattrapable. */
  private readonly released = computed(() =>
    this.outbound().some((e) => e.kind === 'release'),
  );

  protected readonly progressTile = computed(() => {
    const t = this.locTally();
    const goal = this.slotGoal();
    // L'objectif passe avant le release : il declenche de toute facon la remise du reste.
    if (goal.reached) {
      return {
        value: '',
        trophy: true,
        caption: this.t('tile.goal'),
        note:
          this.t('tile.goal.note') +
          (t.remaining !== null && t.remaining > 0
            ? '\n\n' + this.t('tile.goal.remaining', { count: t.remaining })
            : ''),
        warn: false,
      };
    }
    if (this.released()) {
      return {
        value: t.total !== null ? `${truncPercent(t.checked, t.total)} %` : '—',
        trophy: false,
        caption: this.t('tile.release'),
        note: this.t('tile.release.note'),
        warn: false,
      };
    }
    if (t.ratio !== null && t.ratio >= 1) {
      return {
        value: '100.00 %',
        trophy: false,
        caption: this.t('tile.allFound'),
        note: this.t('tile.allFound.note'),
        warn: false,
      };
    }
    if (t.ratio === null) {
      return {
        value: '—',
        trophy: false,
        caption: this.t('tile.unknown'),
        note: this.t('tile.unknown.note'),
        warn: true,
      };
    }
    return {
      value: `${truncPercent(t.checked, t.total ?? 1)} %`,
      trophy: false,
      caption: this.t('tile.checksLeft', { count: t.remaining ?? 0 }),
      note: this.t('pl.locNote.total', { total: t.total ?? 0 }),
      warn: false,
    };
  });

  /** Legende construite ici et non dans le gabarit : `??` y lie moins fort que `+`. */
  protected readonly hintTile = computed(() => {
    const h = this.hintEconomy();
    const approx = h.costExact ? '' : '~';
    const parts: string[] = [];
    if (h.freeHints) parts.push(this.t('tile.hints.free'));
    else if (h.costPoints !== null) parts.push(this.t('tile.hints.cost', { approx, cost: h.costPoints }));
    if (h.balance !== null) parts.push(this.t('tile.hints.balance', { count: h.balance }));
    if (h.earned !== null) parts.push(this.t('tile.hints.earned', { count: h.earned }));

    const notes: string[] = [];
    if (h.costPoints === null && !h.freeHints) {
      notes.push(this.t('tile.hints.costUnknown'));
    } else if (h.costExact) {
      notes.push(this.t('tile.hints.costExact', { cost: h.costPoints ?? 0 }));
    } else if (h.costPoints !== null) {
      notes.push(
        this.t('tile.hints.costApprox', {
          cost: h.costPoints,
          checks: h.checksPerHint ?? '?',
          per: h.perCheck ?? '?',
        }),
      );
    }
    if (h.balance === null) {
      notes.push(this.t('tile.hints.balanceUnknown'));
    } else if (h.spentAtLeast !== null) {
      notes.push(this.t('tile.hints.spent', { count: h.spentAtLeast, freshness: this.hintBalanceFreshness() }));
    }
    return {
      value: h.freeHints ? '∞' : h.affordableHints !== null ? String(h.affordableHints) : '—',
      caption: this.t('tile.hints', { count: h.freeHints ? 2 : (h.affordableHints ?? 2) }),
      detail: parts.join(' · '),
      note: notes.join('\n\n'),
      warn: h.balance === null || (h.costPoints === null && !h.freeHints),
    };
  });

  protected readonly deathTile = computed(() => {
    const d = this.slotDeaths();
    if (!d) return null;
    const heard = this.t('tile.deaths.heard');
    const share =
      d.count !== null && d.share !== null
        ? '\n\n' + this.t('tile.deaths.share', { pct: (d.share * 100).toFixed(0) })
        : '';
    // Un slot sans tag ne vaut ni `0` ni `—`, et n'est pas « desactive » : seulement non annonce.
    switch (d.knowledge) {
      case 'untagged':
        return {
          value: '∅',
          caption: this.t('tile.deaths.untagged'),
          note: this.t('tile.deaths.untagged.note'),
          warn: false,
        };
      case 'unknown':
        return {
          value: '—',
          caption: this.t('tile.deaths.noData'),
          note: `${d.why}.\n\n${heard}`,
          warn: true,
        };
      default:
        return {
          value: String(d.count),
          caption: this.t('tile.deaths.sent', { count: d.count ?? 0 }),
          note: `${d.why}.\n\n${heard}${share}`,
          warn: false,
        };
    }
  });

  private readonly receivedByClass = computed(() => {
    const slot = this.loadedSlot();
    if (slot === null) return null;
    return countEvents(this.inbound()).itemsByClassBySlot.get(slot) ?? null;
  });

  protected readonly classBar = computed(() => {
    const t = this.receivedByClass();
    return t ? classSegments(t, this.t) : [];
  });

  /** La couleur seule ne porte jamais l'information. */
  protected readonly classLabelAll = computed(() =>
    this.classBar()
      .map((s) => s.title)
      .join(', '),
  );

  protected readonly classTotal = computed(() => {
    const t = this.receivedByClass();
    if (!t) return 0;
    return (Object.keys(t) as (keyof typeof t)[]).reduce((n, k) => n + t[k], 0);
  });

  protected readonly locNote = computed(() => {
    const t = this.locTally();
    const lines = [
      t.total === null ? this.t('pl.locNote.unknown') : this.t('pl.locNote.total', { total: t.total }),
    ];
    const over = this.locListOverhang();
    if (over !== null) {
      lines.push(this.t('pl.locNote.over', { count: over }));
    }
    return lines.join('\n\n');
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancelReload());

    effect(() => {
      const roster = this.roster();
      if (!roster.length) return;
      const keep = this.selected();
      if (keep !== null && roster.some((r) => r.slot === keep)) return;
      this.selected.set(this.ap.ownSlot() ?? roster[0].slot);
    });

    // Un id d'objet ne designe pas la meme chose d'un jeu a l'autre.
    effect(() => {
      this.selected();
      untracked(() => {
        if (this.expanded().size) this.expanded.set(new Set());
      });
    });

    // Un filtre dont l'onglet disparait laisserait une liste vide sans moyen d'en sortir.
    effect(() => {
      const own = this.ownSlotSelected();
      if (!own && this.status() === 'missing') this.status.set('all');
      if (!own && this.locStatus() === 'missing') this.locStatus.set('all');
      if (this.status() === 'unknown' && this.unknownItems() === 0) this.status.set('all');
      if (this.locStatus() === 'unknown' && this.unknownLocs() === 0) this.locStatus.set('all');
    });

    effect(() => {
      const slot = this.selected();
      this.ap.eventCount();
      if (slot === null) return;
      // Hors suivi : `reload` les ecrit, sinon l'effet boucle toutes les 15 s sur son resultat.
      const [at, loaded] = untracked(() => [this.loadedAt(), this.loadedSlot()]);
      if (slot !== loaded) {
        this.cancelReload();
        void this.reload(slot, false);
        return;
      }
      if (this.reloadTimer !== null) return;
      const since = Date.now() - at;
      if (since >= RELOAD_THROTTLE_MS) {
        void this.reload(slot);
        return;
      }
      // Le minuteur en attente ne se remplace pas : sinon un flux continu repousse le rechargement.
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        void this.reload(slot);
      }, RELOAD_THROTTLE_MS - since);
    });
  }

  protected select(slot: number): void {
    this.selected.set(slot);
  }

  protected isExpanded(id: number): boolean {
    return this.expanded().has(id);
  }

  /** Le bouton `xN` n'a pas de gestionnaire propre : son clic remonte ici, sinon double bascule. */
  protected toggleSources(row: ItemRow): void {
    if (row.sources.length < 2) return;
    const next = new Set(this.expanded());
    if (!next.delete(row.id)) next.add(row.id);
    this.expanded.set(next);
  }

  protected toggleTextClient(slot: number): void {
    void this.ap.toggleTextClientSlot(slot);
  }

  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  private cancelReload(): void {
    if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
  }

  /** Seule la derniere lecture ecrit : une lecture lente de A finirait sinon sur le panneau de B. */
  private reloadSeq = 0;

  /** `silent` : un rafraichissement du meme slot n'attenue pas le panneau. */
  protected async reload(slot: number, silent = true): Promise<void> {
    const roomId = this.ap.roomId();
    if (!roomId) return;
    const seq = ++this.reloadSeq;
    if (!silent) this.loading.set(true);
    try {
      const roster = this.roster();
      const game = roster.find((r) => r.slot === slot)?.game ?? '';
      const games = [...new Set(roster.map((r) => r.game).filter((g) => g))];
      const [inbound, outbound, stats, pack, snap, packs, room] = await Promise.all([
        db.events
          .where('[roomId+dstSlot+ts]')
          .between([roomId, slot, Dexie.minKey], [roomId, slot, Dexie.maxKey])
          .toArray(),
        db.events
          .where('[roomId+srcSlot+ts]')
          .between([roomId, slot, Dexie.minKey], [roomId, slot, Dexie.maxKey])
          .toArray(),
        db.slotStats.get([roomId, slot]),
        game ? db.dataPackages.get(game) : Promise.resolve(undefined),
        db.snapshots
          .where('[roomId+slot+ts]')
          .between([roomId, slot, Dexie.minKey], [roomId, slot, Dexie.maxKey])
          .last(),
        db.dataPackages.bulkGet(games),
        db.rooms.get(roomId),
      ]);
      if (seq !== this.reloadSeq) return;
      const byGame = new Map(packs.filter((p) => p !== undefined).map((p) => [p!.game, p!]));
      const bySlot = <T>(pick: (p: CachedGamePackage) => T) =>
        new Map(
          roster
            .map((r) => [r.slot, byGame.has(r.game) ? pick(byGame.get(r.game)!) : undefined] as const)
            .filter((e): e is readonly [number, T] => e[1] !== undefined),
        );
      this.itemCatalogues.set(bySlot((p) => p.itemIdToName));
      this.locCatalogues.set(bySlot((p) => p.locationIdToName));
      this.inbound.set(inbound);
      this.outbound.set(outbound);
      this.catalogue.set(pack?.itemIdToName ?? null);
      this.locCatalogue.set(pack?.locationIdToName ?? null);
      this.totalLocations.set(stats?.totalLocations ?? null);
      this.checkedFromServer.set(stats?.checkedFromServer ?? null);
      this.slotHintPoints.set(stats?.hintPoints ?? null);
      this.slotHintCostObserved.set(stats?.hintCostObserved ?? null);
      this.slotHintCostObservedFor.set(stats?.hintCostObservedFor ?? null);
      this.roomHintCost.set(room?.hintCost ?? null);
      this.roomCheckPoints.set(room?.locationCheckPoints ?? null);
      this.snapshot.set(snap?.checkedLocations ?? null);
      this.slotStatusStored.set(stats?.status ?? null);
      this.loadedSlot.set(slot);
      this.loadedAt.set(Date.now());
    } finally {
      if (seq === this.reloadSeq) this.loading.set(false);
    }
  }

  protected presenceGlyph(state: PresenceKind): string {
    switch (state) {
      case 'online':
        return '●';
      case 'observer':
        return '◐';
      case 'offline':
        return '○';
      case 'unknown':
        return '◌';
      default:
        return '·';
    }
  }

  protected presenceTitle(row: RosterRow): string {
    const v = this.ap.presence()[row.slot];
    const detail = v ? this.t('presence.detail', { players: v.players, observers: v.observers }) : '';
    switch (row.presence) {
      case 'online':
      case 'observer':
      case 'offline':
        return this.t(`presence.title.${row.presence}`, { detail });
      case 'unknown':
        return this.t('presence.title.unknown');
      default:
        return this.t('presence.title.none');
    }
  }

  protected presenceWord(state: PresenceKind): string {
    return this.t(`presence.${state === 'online' || state === 'observer' || state === 'offline' || state === 'unknown' ? state : 'none'}`);
  }

  protected flowName(r: FlowRow): string {
    return r.slot === null ? this.t('pl.flow.others', { count: r.players }) : r.name;
  }

  protected classOf(cls: ItemClass | 'unknown' | null): string {
    return cls && cls !== 'unknown' ? `item-${cls}` : 'item-unknown';
  }

  protected classTitle(cls: ItemClass | 'unknown' | null): string {
    if (cls === null) return this.t('itemClass.never');
    if (cls === 'unknown') return this.t('itemClass.unresolvedTitle');
    return this.t(ITEM_CLASS_LABEL[cls]);
  }

  protected glyphOf(cls: ItemClass | 'unknown' | null): string {
    return cls && cls !== 'unknown' ? ITEM_CLASS_GLYPH[cls] : '?';
  }

  protected time(ts: number): string {
    return this.i18n.datetime(ts);
  }

  protected countTitle(row: ItemRow): string {
    const n = row.sources.length;
    return this.t(row.status === 'hinted' ? 'pl.countTitle.hints' : 'pl.countTitle.copies', { count: n });
  }

  protected sourceTitle(row: ItemRow): string {
    const list = row.sources;
    if (!list.length) return '';
    const line = (s: ItemSource) => {
      const where = s.playerName ? `${s.playerName} — ${s.locationName}` : this.t('pl.granted');
      return `${where} (${s.approx ? '~' : ''}${this.time(s.ts)})`;
    };
    if (list.length === 1) return this.t('pl.source', { line: line(list[0]) });
    const head = this.t('pl.sources', { count: list.length });
    return [head, ...list.map((s) => `· ${line(s)}`)].join('\n');
  }

  protected stamp(ts: number): string {
    return shortStamp(ts, Date.now(), this.i18n.dateStyle()).text;
  }
}
