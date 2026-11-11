import { inject, Injectable, signal } from '@angular/core';
import Dexie from 'dexie';
import {
  db,
  type ApEvent,
  type CaptureSession,
  type PresenceInterval,
  type RenderedSegment,
  type Room,
  type SlotStats,
} from '../db/db';
import { gapDuration, lastCoveredBefore, mergeCoverage, sessionEndAt, type Interval } from '../ingest/coverage';
import { PresenceTracker, type PresenceOp } from '../ingest/presence';
import { rebuildPresenceRows } from '../ingest/presence-store';
import { ACTIVITY_KINDS } from '../ingest/rebuild-presence';
import { computeReceivedGaps, placedDedupKey } from '../ingest/received-items';
import { computeHintGaps, hintDedupSuffix, hintsKey, parseHintsKey } from '../ingest/hints';
import {
  clientStatusKey,
  parseClientStatusKey,
  readClientStatus,
} from '../ingest/client-status';
import { computeGapChecks, selectScoutTargets } from '../ingest/reconcile';
import { decideSweep, selectSweepTargets, type SweepDecision } from '../ingest/sweep';
import { matchesSearch, normalizeQuery } from '../select/feed-search';
import { candidateUrls } from './ap-url';
import { scoutSlot } from './scout';
import { itemClassCss, itemClassOf, ITEM_CLASS_GLYPH } from '../protocol/item-class';
import { VIGIPELAGO_TAG } from '../protocol/tags';
import { DEATHLINK_TAG, buildDeathDraft, isDeathLink, renderDeath } from '../ingest/deathlink';
import { I18n } from '../i18n/i18n.service';
import { fallbackNames } from '../select/fallback-names';
import { decodePrintJson, type EventDraft } from '../protocol/decode';
import { NameResolver } from '../protocol/names';
import {
  CLIENT_VERSION,
  ITEMS_HANDLING_ALL,
  type ConnectedPacket,
  type ConnectionRefusedPacket,
  type BouncedPacket,
  type DataPackagePacket,
  type Hint,
  type LocationInfoPacket,
  type RetrievedPacket,
  type SetReplyPacket,
  type NetworkItem,
  type NetworkSlot,
  type NetworkVersion,
  type PrintJsonPacket,
  type ReceivedItemsPacket,
  type RoomInfoPacket,
  type RoomUpdatePacket,
  type ServerPacket,
} from '../protocol/types';
import { ApSocket, type SocketState } from './ap-socket';
import { storedRows } from './bulk-insert';
import { readHintCostReply, validateObservedHintCost } from '../select/hint-economy';

export const APP_VERSION = '0.12.0';

/** Lignes gardees en memoire, pas l'etendue de la recherche. */
export const FEED_LIMIT = 2000;

/** La coupe se fait sur les lignes les plus anciennes. */
export const SEARCH_LIMIT = 5000;
const FLUSH_INTERVAL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 15_000;
const SCOUT_CHUNK = 250;

export interface ConnectionParams {
  host: string;
  port: number;
  slotName: string;
  password: string;
}

export type PresenceState = PresenceInterval['state'];

/** `checked_locations` ne concerne que le slot connecte. */
export interface ReconcileReport {
  slot: number;
  slotName: string;
  received: number;
  alreadyKnown: number;
  created: number;
  tsLower: number;
  tsUpper: number;
}

export interface SlotPresenceView {
  state: PresenceState;
  players: number;
  observers: number;
  textClient: boolean;
}

export interface ItemRecoveryReport {
  slot: number;
  slotName: string;
  received: number;
  created: number;
  tsLower: number;
  tsUpper: number;
}

export const TEXT_CLIENT_KEY = (roomId: string) => `textClientSlots:${roomId}`;

export interface SweepProgress {
  running: boolean;
  total: number;
  done: number;
  current: string | null;
  created: number;
  itemsRecovered: number;
  /** Des contenus resolus sur des lignes existantes, pas des checks. */
  contentFilled: number;
  failed: { slot: string; error: string }[];
  reason: SweepDecision['reason'];
  gapMs: number;
}

const LAST_SWEEP_KEY = (roomId: string) => `lastSweepAt:${roomId}`;
/** Par room, absent = desactive : chaque passage se connecte sous le nom des autres slots. */
export const SWEEP_ENABLED_KEY = (roomId: string) => `sweepEnabled:${roomId}`;

export const ROOM_SETTINGS_KEYS = (roomId: string) => [
  TEXT_CLIENT_KEY(roomId),
  LAST_SWEEP_KEY(roomId),
  SWEEP_ENABLED_KEY(roomId),
];

const SWEEP_DELAY_MS = 300;
const CAPTURE_LOCK = 'vigipelago-capture';
/** `idle` en est exclu : la deconnexion voulue ferme elle-meme, avec sa raison. */
const DROPPED_STATES: ReadonlySet<SocketState> = new Set(['backoff', 'unreachable', 'fatal', 'connecting']);

const RACE_MODE_KEY = '_read_race_mode';

type RoomMeta = Pick<Room, 'serverVersion' | 'generatorVersion' | 'permissions' | 'password'>;
const EMPTY_ROOM_META: RoomMeta = {
  serverVersion: null,
  generatorVersion: null,
  permissions: null,
  password: null,
};

function versionLabel(v: NetworkVersion | undefined): string | null {
  return v && typeof v.major === 'number' ? `${v.major}.${v.minor}.${v.build}` : null;
}

@Injectable({ providedIn: 'root' })
export class ApSessionService {
  readonly state = signal<SocketState>('idle');
  readonly detail = signal<string>('');
  readonly feed = signal<ApEvent[]>([]);
  readonly roomId = signal<string | null>(null);
  readonly players = signal<{ slot: number; name: string; game: string }[]>([]);
  readonly ownSlot = signal<number | null>(null);
  readonly eventCount = signal<number>(0);
  readonly missingDataPackages = signal<string[]>([]);
  /** Une cle rendue vide compte ; une cle absente, non. */
  readonly hintsFromServer = signal(false);
  /** Slot absent : inconnu. Valeur `null` : slot jamais connecte. */
  readonly slotStatus = signal<ReadonlyMap<number, number | null>>(new Map());

  readonly presence = signal<Record<number, SlotPresenceView>>({});
  readonly coverage = signal<Interval[]>([]);
  readonly gapTotalMs = signal<number>(0);
  readonly reconcileReport = signal<ReconcileReport | null>(null);
  readonly lastError = signal<string>('');
  readonly presenceRebuilt = signal<number>(0);
  /** Notre slot seulement ; les autres sont dans `sweep()`. */
  readonly itemRecovery = signal<ItemRecoveryReport | null>(null);
  readonly sweep = signal<SweepProgress | null>(null);
  /** Chaque passage est visible des autres joueurs. */
  readonly sweepEnabled = signal<boolean>(false);

  /** Room affichee depuis la base, sans connexion. Ce n'est pas `roomId`. */
  readonly localRoomId = signal<string | null>(null);
  /** Aucune cible : se reconnecter viserait la derniere, peut-etre une autre partie. */
  readonly browseOnly = signal(false);
  /** `false` : un autre onglet capture, celui-ci ne peut que consulter. `null` le temps de le savoir. */
  readonly captureOwner = signal<boolean | null>(null);
  readonly autoRetry = signal<boolean>(false);
  /** Separes de `detail`, qui porte l'URL et ne doit jamais s'afficher. */
  readonly refusal = signal<readonly string[]>([]);

  /** Modifiables en cours de partie. */
  readonly permissions = signal<Record<string, number>>({});
  readonly hintPoints = signal<number>(0);
  readonly hintCostObserved = signal<number | null>(null);

  private readonly names = new NameResolver();
  private readonly socket: ApSocket;
  private readonly tracker: PresenceTracker;
  private params: ConnectionParams | null = null;
  /** Un lot a la fois : garantit l'ordre `Connected` -> `ReceivedItems`. */
  private chain: Promise<void> = Promise.resolve();

  private sessionId: number | null = null;
  private sessionStartedAt = 0;
  private currentRoomId: string | null = null;
  private roomCreatedAt: number | null = null;
  /** Arrive au `RoomInfo`, avant que la room soit ecrite. */
  private roomHintCost: number | null = null;
  private readonly i18n = inject(I18n);
  private roomCheckPoints: number | null = null;
  private roomMeta: RoomMeta = EMPTY_ROOM_META;
  private team = 0;
  private resolverReady = false;
  private pending: { packet: PrintJsonPacket; ts: number }[] = [];
  private writeQueue: ApEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private textClientSlots: ReadonlySet<number> = new Set();
  private slotInfo: Record<string, NetworkSlot> = {};
  private priorCoverage: Interval[] = [];
  /** Figee a la connexion : la couverture inclut deja cette session. */
  private gapTsLower: number | null = null;
  private sweepToken = 0;
  private readonly presenceIds = new WeakMap<PresenceInterval, Promise<number>>();

  constructor() {
    this.names.fallback = fallbackNames(this.i18n.t);
    this.tracker = new PresenceTracker((op) => this.onPresenceOp(op));
    this.socket = new ApSocket({
      onState: (s, d) => {
        this.state.set(s);
        this.detail.set(d ?? '');
        // La session suit la socket : ouverte au `Connected`, fermee des que la liaison tombe.
        if (DROPPED_STATES.has(s) && this.sessionId !== null) {
          const end = sessionEndAt(this.sessionStartedAt, this.socket.lastHeardAt, Date.now());
          void this.guard('Session', this.closeSession('socket-error', end));
        }
      },
      onOpen: () => {
        this.resolverReady = false;
        this.pending = [];
      },
      onPackets: (packets) => this.handlePackets(packets),
    });

    void this.claimCapture();
    window.addEventListener('beforeunload', () => void this.closeSession('unload'));
  }

  connect(params: ConnectionParams): void {
    if (this.captureOwner() === false) return;
    this.params = params;
    this.browseOnly.set(false);
    this.forgetRoom();
    this.refusal.set([]);
    this.socket.connect({ host: params.host, port: params.port });
    this.startFlushLoop();
  }

  disconnect(): void {
    this.sweepToken++;
    this.setAutoRetry(false);
    this.socket.disconnect('user');
    void this.closeSession('user');
    this.localRoomId.set(null);
    this.browseOnly.set(false);
    this.forgetRoom();
    this.stopLoops();
  }

  forgetRoom(): void {
    this.roomId.set(null);
    this.currentRoomId = null;
    this.roomCreatedAt = null;
    this.roomHintCost = null;
    this.roomCheckPoints = null;
    this.roomMeta = EMPTY_ROOM_META;
    this.players.set([]);
    this.ownSlot.set(null);
    this.feed.set([]);
    this.eventCount.set(0);
    this.presence.set({});
    this.coverage.set([]);
    this.gapTotalMs.set(0);
    this.reconcileReport.set(null);
    this.itemRecovery.set(null);
    this.sweep.set(null);
    this.sweepEnabled.set(false);
    this.missingDataPackages.set([]);
    this.hintsFromServer.set(false);
    this.permissions.set({});
    this.hintPoints.set(0);
    this.hintCostObserved.set(null);
  }

  /** Ne vide pas le journal, contrairement a `connect`. */
  retry(): void {
    if (!this.params) return;
    this.lastError.set('');
    this.refusal.set([]);
    // Hors connexion, `browseLocal` a vide la console : sans ceci elle reste vide pendant les tentatives.
    const roomId = this.roomId();
    if (roomId !== null && this.localRoomId() !== null) {
      this.localRoomId.set(null);
      void this.guard('History', this.loadHistory(roomId));
    }
    this.socket.connect({ host: this.params.host, port: this.params.port });
    this.startFlushLoop();
  }

  setAutoRetry(on: boolean): void {
    this.autoRetry.set(on);
    this.socket.autoRetry = on;
    if (on && this.state() === 'unreachable') this.retry();
  }

  async browseLocal(roomId: string, opts: { detached?: boolean } = {}): Promise<void> {
    if (opts.detached) {
      this.params = null;
      this.browseOnly.set(true);
    }
    this.localRoomId.set(roomId);
    // Hors connexion la console reste vide, voulu.
    await this.reloadFromDb(roomId, { withFeed: false });
  }

  /** Rien n'est ecrit au journal : la ligne revient en `PrintJSON`. */
  say(text: string): boolean {
    const line = text.trim();
    if (!line || this.state() !== 'online') return false;
    this.socket.send([{ cmd: 'Say', text: line }]);
    return true;
  }

  async sweepNow(): Promise<void> {
    const roomId = this.currentRoomId;
    if (!roomId || !this.sweepEnabled()) return;
    await this.runSweep(roomId, this.ownSlot(), Date.now(), { reason: 'jamais-balaye', gapMs: 0 });
  }

  private async loadSweepEnabled(roomId: string): Promise<boolean> {
    const row = await db.settings.get(SWEEP_ENABLED_KEY(roomId));
    const enabled = row ? Boolean(row.value) : false;
    if (this.roomId() === roomId) this.sweepEnabled.set(enabled);
    return enabled;
  }

  async setSweepEnabled(enabled: boolean): Promise<void> {
    const roomId = this.roomId();
    if (roomId === null) return;
    this.sweepEnabled.set(enabled);
    await db.settings.put({ key: SWEEP_ENABLED_KEY(roomId), value: enabled });
  }

  private handlePackets(packets: ServerPacket[]): void {
    // Fige a la reception : la file peut prendre du retard.
    const now = Date.now();
    this.chain = this.chain.then(() => this.processPackets(packets, now));
  }

  /** Sequentiel : `ReceivedItems` lit ce que `onConnected` renseigne apres son premier `await`. */
  private async processPackets(packets: readonly ServerPacket[], now: number): Promise<void> {
    for (const p of packets) {
      switch (p.cmd) {
        case 'RoomInfo':
          await this.guard('RoomInfo', this.onRoomInfo(p as RoomInfoPacket));
          break;
        case 'DataPackage':
          await this.guard('DataPackage', this.onDataPackage(p as DataPackagePacket));
          break;
        case 'Connected':
          await this.guard('Connected', this.onConnected(p as ConnectedPacket));
          break;
        case 'ConnectionRefused':
          this.onRefused(p as ConnectionRefusedPacket);
          break;
        case 'RoomUpdate':
          await this.guard('RoomUpdate', this.onRoomUpdate(p as RoomUpdatePacket));
          break;
        case 'Retrieved':
          await this.guard('Retrieved', this.onRetrieved(p as RetrievedPacket, now));
          break;
        case 'SetReply':
          await this.guard('SetReply', this.onSetReply(p as SetReplyPacket, now));
          break;
        case 'LocationInfo':
          await this.guard('LocationInfo', this.onLocationInfo(p as LocationInfoPacket));
          break;
        case 'ReceivedItems':
          await this.guard('ReceivedItems', this.onReceivedItems(p as ReceivedItemsPacket, now));
          break;
        case 'PrintJSON':
          this.onPrintJson(p as PrintJsonPacket, now);
          break;
        case 'Bounced':
          this.onBounced(p as BouncedPacket, now);
          break;
        default:
          break;
      }
    }
  }

  private guard(what: string, work: Promise<unknown>): Promise<void> {
    return work.then(
      () => undefined,
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.lastError.set(`${what} : ${msg}`);
        console.error(`[Vigipelago] ${what}`, e);
      },
    );
  }

  private async onRoomInfo(info: RoomInfoPacket): Promise<void> {
    if (!this.params) return;
    this.currentRoomId = info.seed_name;
    this.roomId.set(info.seed_name);
    void this.loadSweepEnabled(info.seed_name);
    // `RoomInfo.time` est en secondes.
    this.roomCreatedAt = typeof info.time === 'number' ? Math.round(info.time * 1000) : null;
    this.permissions.set(info.permissions ?? {});
    this.roomMeta = {
      serverVersion: versionLabel(info.version),
      generatorVersion: versionLabel(info.generator_version),
      permissions: info.permissions ?? null,
      password: typeof info.password === 'boolean' ? info.password : null,
    };
    this.roomHintCost = typeof info.hint_cost === 'number' ? info.hint_cost : null;
    this.roomCheckPoints =
      typeof info.location_check_points === 'number' ? info.location_check_points : null;

    const checksums = info.datapackage_checksums ?? {};

    const needed: string[] = [];
    for (const [game, checksum] of Object.entries(checksums)) {
      const cached = await db.dataPackages.get(game);
      if (cached && cached.checksum === checksum) {
        this.names.setGameData(game, cached.itemIdToName, cached.locationIdToName);
      } else {
        needed.push(game);
      }
    }
    this.missingDataPackages.set(needed);
    if (needed.length) {
      this.socket.send([{ cmd: 'GetDataPackage', games: needed }]);
    }

    this.socket.send([
      {
        cmd: 'Connect',
        password: this.params.password || null,
        game: '',
        name: this.params.slotName,
        uuid: this.uuid(),
        version: CLIENT_VERSION,
        // Non nul, sinon pas de liste des objets deja recus.
        items_handling: ITEMS_HANDLING_ALL,
        // Sans notre tag l'outil compte comme un joueur ; sans DeathLink, aucune mort recue.
        tags: ['TextOnly', VIGIPELAGO_TAG, DEATHLINK_TAG],
        slot_data: false,
      },
    ]);

    this.tryReleasePending();
  }

  private async onDataPackage(pkt: DataPackagePacket): Promise<void> {
    const rows = [];
    for (const [game, pack] of Object.entries(pkt.data?.games ?? {})) {
      const itemIdToName: Record<number, string> = {};
      for (const [name, id] of Object.entries(pack.item_name_to_id ?? {})) itemIdToName[id] = name;
      const locationIdToName: Record<number, string> = {};
      for (const [name, id] of Object.entries(pack.location_name_to_id ?? {})) locationIdToName[id] = name;
      this.names.setGameData(game, itemIdToName, locationIdToName);
      rows.push({ game, checksum: pack.checksum, itemIdToName, locationIdToName });
    }
    await db.dataPackages.bulkPut(rows);
    this.missingDataPackages.set([]);
    this.tryReleasePending();
  }

  private async onConnected(pkt: ConnectedPacket): Promise<void> {
    const now = Date.now();
    const roomId = this.currentRoomId!;
    this.team = pkt.team;

    // Sinon la couverture de la session ouverte s'etend sur la coupure.
    await this.closeSession('socket-error');

    this.names.setPlayers(pkt.players, pkt.slot_info);
    this.names.ownSlot = pkt.slot;
    this.socket.ownSlot = pkt.slot;
    this.ownSlot.set(pkt.slot);
    this.publishPlayers(pkt.players);

    const existing = await db.rooms.get(roomId);
    await db.rooms.put({
      roomId,
      seedName: roomId,
      label: existing?.label ?? roomId,
      host: this.params!.host,
      port: this.params!.port,
      players: pkt.players.map((p) => ({
        team: p.team,
        slot: p.slot,
        name: p.name,
        alias: p.alias,
        game: this.names.gameOf(p.slot) ?? '',
      })),
      firstSeenAt: existing?.firstSeenAt ?? now,
      createdAt: this.roomCreatedAt ?? existing?.createdAt ?? null,
      lastSeenAt: now,
      hintCost: this.roomHintCost ?? existing?.hintCost ?? null,
      locationCheckPoints: this.roomCheckPoints ?? existing?.locationCheckPoints ?? null,
      serverVersion: this.roomMeta.serverVersion ?? existing?.serverVersion ?? null,
      generatorVersion: this.roomMeta.generatorVersion ?? existing?.generatorVersion ?? null,
      permissions: this.roomMeta.permissions ?? existing?.permissions ?? null,
      password: this.roomMeta.password ?? existing?.password ?? null,
      raceMode: existing?.raceMode ?? null,
    });

    const priorSessions = await db.sessions.where('roomId').equals(roomId).toArray();
    const priorCoverage = mergeCoverage(priorSessions, now);
    this.priorCoverage = priorCoverage;
    this.slotInfo = pkt.slot_info ?? {};

    this.textClientSlots = await this.loadTextClientSlots(roomId);
    await this.rebuildPresence(roomId, priorSessions, pkt);

    this.sessionStartedAt = now;
    this.sessionId = (await db.sessions.add({
      roomId,
      connectedAsSlot: this.params!.slotName,
      startedAt: now,
      endedAt: null,
      lastHeartbeatAt: now,
      closeReason: 'live',
      appVersion: APP_VERSION,
    } satisfies CaptureSession)) as number;
    this.startHeartbeat();

    this.hintPoints.set(pkt.hint_points ?? 0);
    await this.recordSlotTotals(
      roomId,
      pkt.slot,
      pkt.checked_locations,
      pkt.missing_locations,
      now,
      typeof pkt.hint_points === 'number' ? pkt.hint_points : null,
    );
    await this.reconcile(pkt, priorCoverage, now);

    await db.snapshots.add({
      roomId,
      team: pkt.team,
      slot: pkt.slot,
      ts: now,
      sessionId: this.sessionId,
      // Les ids vont de -2^53+1 a 2^53-1 : jamais de tableau type.
      checkedLocations: [...pkt.checked_locations].sort((a, b) => a - b),
    });

    this.tracker.begin(
      roomId,
      pkt.team,
      pkt.players.map((p) => p.slot),
      now,
    );
    this.tracker.setTextClientSlots(this.textClientSlots, now);
    this.publishPresence();

    await this.refreshCoverage(roomId, now);
    await this.loadHistory(roomId);
    this.localRoomId.set(null);
    this.socket.markHandshakeDone();
    this.tryReleasePending();

    this.requestHints();
    // Le `PrintJSON` de type Goal ne passe qu'une fois : l'etat se relit.
    this.requestClientStatus();
    this.socket.send([{ cmd: 'Get', keys: [RACE_MODE_KEY] }]);

    // Hors file : le balayage ne doit pas retenir les paquets qui suivent.
    void this.guard(this.i18n.t('bar.sweep'), this.maybeSweep(roomId, pkt.slot, now));
  }

  private async reconcile(pkt: ConnectedPacket, priorCoverage: Interval[], now: number): Promise<void> {
    const roomId = this.currentRoomId!;
    const tsLower = lastCoveredBefore(priorCoverage, now) ?? this.roomCreatedAt ?? now;
    // `ReceivedItems` arrive apres, quand la couverture inclut deja cette session.
    this.gapTsLower = tsLower;

    const res = await this.writeGapChecks({
      roomId,
      team: pkt.team,
      slot: pkt.slot,
      checkedLocations: pkt.checked_locations,
      tsLower,
      tsUpper: now,
    });

    this.reconcileReport.set({
      slot: pkt.slot,
      slotName: this.names.playerName(pkt.slot),
      received: pkt.checked_locations.length,
      alreadyKnown: res.alreadyKnown,
      created: res.created,
      tsLower,
      tsUpper: now,
    });
    // Tout le non-resolu, pas les seuls ecarts crees : une ancienne ligne vide ne serait jamais reprise.
    const { resolved } = await this.locationIdsOf(roomId, pkt.slot);
    const wanted = selectScoutTargets({
      checkedLocations: pkt.checked_locations,
      resolvedLocationIds: resolved,
    });
    for (let i = 0; i < wanted.length; i += SCOUT_CHUNK) {
      this.socket.send([
        { cmd: 'LocationScouts', locations: wanted.slice(i, i + SCOUT_CHUNK), create_as_hint: 0 },
      ]);
    }
  }

  private async writeGapChecks(params: {
    roomId: string;
    team: number;
    slot: number;
    checkedLocations: readonly number[];
    tsLower: number;
    tsUpper: number;
    items?: Map<number, NetworkItem>;
  }): Promise<{ created: number; alreadyKnown: number; gapIds: number[] }> {
    const { roomId, team, slot, checkedLocations, tsLower, tsUpper, items } = params;
    const known = await this.knownLocationIds(roomId, slot);
    const gaps = computeGapChecks({ checkedLocations, knownLocationIds: known, tsLower, tsUpper });
    const gapIds = gaps.map((g) => g.locationId);
    if (!gaps.length) return { created: 0, alreadyKnown: known.size, gapIds };

    const rows: ApEvent[] = gaps.map((g) => {
      const info = items?.get(g.locationId);
      return {
        roomId,
        ts: g.ts,
        tsPrecision: 'approx' as const,
        tsLower: g.tsLower,
        tsUpper: g.tsUpper,
        kind: 'item' as const,
        team,
        srcSlot: slot,
        // Dans LocationInfo, `player` est le destinataire.
        dstSlot: info?.player ?? null,
        itemId: info?.item ?? null,
        locationId: g.locationId,
        itemFlags: info?.flags ?? null,
        text: '',
        segments: [],
        tags: null,
        sessionId: this.sessionId!,
        raw: { detectedAtReconnect: true, location: g.locationId },
        // Meme cle que l'evenement exact.
        dedupKey: `${roomId}|i:${team}:${slot}:${g.locationId}`,
      };
    });
    for (const row of rows) this.renderApproxRow(row);

    try {
      await db.events.bulkAdd(rows);
    } catch (e) {
      if (!(e instanceof Dexie.BulkError)) throw e;
    }
    return { created: rows.length, alreadyKnown: known.size, gapIds };
  }

  private async patchScoutedRows(params: {
    roomId: string;
    team: number;
    slot: number;
    items: Map<number, NetworkItem>;
  }): Promise<number> {
    const { roomId, team, slot, items } = params;
    let patched = 0;
    for (const [location, info] of items) {
      const key = `${roomId}|i:${team}:${slot}:${location}`;
      const row = await db.events.where('dedupKey').equals(key).first();
      // Une ligne exacte du direct fait foi.
      if (!row || row.id === undefined || row.itemId !== null || row.tsPrecision !== 'approx') continue;
      row.itemId = info.item;
      // Dans LocationInfo, `player` est le destinataire.
      row.dstSlot = info.player;
      row.itemFlags = info.flags;
      this.renderApproxRow(row);
      await db.events.update(row.id, {
        itemId: row.itemId,
        dstSlot: row.dstSlot,
        itemFlags: row.itemFlags,
        text: row.text,
        segments: row.segments,
      });
      patched++;
    }
    return patched;
  }

  /** Ce `put` reecrit la ligne entiere : un `null` ne doit jamais remplacer une valeur connue. */
  private async recordSlotTotals(
    roomId: string,
    slot: number,
    checked: readonly number[],
    missing: readonly number[],
    now: number,
    hintPoints: number | null,
  ): Promise<void> {
    const existing = await db.slotStats.get([roomId, slot]);
    await db.slotStats.put({
      roomId,
      slot,
      totalLocations: checked.length + missing.length,
      checkedFromServer: checked.length,
      hintPoints: hintPoints ?? existing?.hintPoints ?? null,
      hintCostObserved: existing?.hintCostObserved ?? null,
      hintCostObservedFor: existing?.hintCostObservedFor ?? null,
      // Sans ce report, un balayage effacerait l'objectif atteint.
      status: existing?.status ?? null,
      updatedAt: now,
    });
  }

  /** Seul l'index 0 est la liste complete. */
  private async onReceivedItems(pkt: ReceivedItemsPacket, now: number): Promise<void> {
    const roomId = this.currentRoomId;
    const slot = this.ownSlot();
    if (roomId === null || slot === null || pkt.index !== 0) return;

    const tsLower = this.gapTsLower ?? this.roomCreatedAt ?? now;
    const res = await this.writeReceivedItems({
      roomId,
      team: this.team,
      dstSlot: slot,
      items: pkt.items ?? [],
      tsLower,
      tsUpper: now,
    });

    this.itemRecovery.set({
      slot,
      slotName: this.names.playerName(slot),
      received: (pkt.items ?? []).length,
      created: res.created,
      tsLower,
      tsUpper: now,
    });
    if (res.created) await this.loadHistory(roomId);
  }

  private async writeReceivedItems(params: {
    roomId: string;
    team: number;
    dstSlot: number;
    items: readonly NetworkItem[];
    tsLower: number;
    tsUpper: number;
  }): Promise<{ created: number }> {
    const { roomId, team, dstSlot, items, tsLower, tsUpper } = params;
    if (!items.length) return { created: 0 };

    const knownKeys = await this.knownReceivedKeys(roomId, team, dstSlot);
    const gaps = computeReceivedGaps({ roomId, team, dstSlot, items, knownKeys, tsLower, tsUpper });
    if (!gaps.length) return { created: 0 };

    const rows: ApEvent[] = gaps.map((g) => ({
      roomId,
      ts: g.ts,
      tsPrecision: 'approx' as const,
      tsLower: g.tsLower,
      tsUpper: g.tsUpper,
      kind: 'item' as const,
      team,
      srcSlot: g.srcSlot,
      dstSlot,
      itemId: g.itemId,
      locationId: g.locationId,
      itemFlags: g.flags,
      text: '',
      segments: [],
      tags: null,
      sessionId: this.sessionId!,
      raw: { detectedFromReceivedItems: true, index: g.index },
      dedupKey: g.dedupKey,
    }));
    for (const row of rows) this.renderApproxRow(row);

    let created = rows.length;
    try {
      await db.events.bulkAdd(rows);
    } catch (e) {
      if (!(e instanceof Dexie.BulkError)) throw e;
      created -= e.failures.length;
    }
    return { created };
  }

  /** Un objet place partage sa cle avec le check qui l'a livre, ecrit cote emetteur. */
  private async knownReceivedKeys(roomId: string, team: number, dstSlot: number): Promise<Set<string>> {
    const rows = await db.events
      .where('[roomId+dstSlot+ts]')
      .between([roomId, dstSlot, Dexie.minKey], [roomId, dstSlot, Dexie.maxKey])
      .toArray();
    const keys = new Set<string>();
    for (const r of rows) {
      if (r.kind !== 'item') continue;
      keys.add(r.dedupKey);
      // Une ligne ecrite cote emetteur sans contenu resolu porte deja cette cle.
      if (r.srcSlot !== null && r.locationId !== null) {
        keys.add(placedDedupKey(roomId, team, r.srcSlot, r.locationId));
      }
    }
    return keys;
  }

  private async knownLocationIds(roomId: string, slot: number): Promise<Set<number>> {
    return (await this.locationIdsOf(roomId, slot)).known;
  }

  /** `known` decide de creer, `resolved` de scouter : les confondre fige un contenu inconnu. */
  private async locationIdsOf(
    roomId: string,
    slot: number,
  ): Promise<{ known: Set<number>; resolved: Set<number> }> {
    const rows = await db.events
      .where('[roomId+srcSlot+ts]')
      .between([roomId, slot, Dexie.minKey], [roomId, slot, Dexie.maxKey])
      .toArray();
    const known = new Set<number>();
    const resolved = new Set<number>();
    for (const r of rows) {
      if (r.kind !== 'item' || r.locationId === null) continue;
      known.add(r.locationId);
      if (r.itemId !== null) resolved.add(r.locationId);
    }
    return { known, resolved };
  }

  private async onLocationInfo(pkt: LocationInfoPacket): Promise<void> {
    const roomId = this.currentRoomId;
    if (!roomId) return;
    const patched: ApEvent[] = [];

    for (const info of pkt.locations ?? []) {
      const key = `${roomId}|i:${this.team}:${this.ownSlot()}:${info.location}`;
      const row = await db.events.where('dedupKey').equals(key).first();
      if (!row || row.tsPrecision !== 'approx') continue;
      // Dans LocationInfo, `player` est le destinataire.
      row.itemId = info.item;
      row.dstSlot = info.player;
      row.itemFlags = info.flags;
      this.renderApproxRow(row);
      await db.events.update(row.id!, {
        itemId: row.itemId,
        dstSlot: row.dstSlot,
        itemFlags: row.itemFlags,
        text: row.text,
        segments: row.segments,
      });
      patched.push(row);
    }

    if (patched.length) this.replaceInFeed(patched);
  }

  /** Le serveur n'ecrit ces cles que pour l'equipe 0. Le data storage ne date rien. */
  private requestHints(): void {
    const keys = Object.keys(this.slotInfo).map((slot) => hintsKey(this.team, Number(slot)));
    if (!keys.length) return;
    this.socket.send([{ cmd: 'Get', keys }, { cmd: 'SetNotify', keys }]);
  }

  /** Equipe 0 seulement, comme les hints. */
  private requestClientStatus(): void {
    const keys = Object.keys(this.slotInfo).map((slot) => clientStatusKey(this.team, Number(slot)));
    if (!keys.length) return;
    this.socket.send([{ cmd: 'Get', keys }, { cmd: 'SetNotify', keys }]);
  }

  private async storeClientStatus(slot: number, status: number | null): Promise<void> {
    const next = new Map(this.slotStatus());
    next.set(slot, status);
    this.slotStatus.set(next);
    const roomId = this.roomId();
    if (!roomId) return;
    const existing = await db.slotStats.get([roomId, slot]);
    if (existing) {
      await db.slotStats.put({ ...existing, status, updatedAt: Date.now() });
    }
  }

  private async onRetrieved(pkt: RetrievedPacket, now: number): Promise<void> {
    const hints: Hint[] = [];
    let answered = false;
    for (const [key, value] of Object.entries(pkt.keys ?? {})) {
      if (key === RACE_MODE_KEY) {
        const roomId = this.currentRoomId;
        // Une valeur absente n'est pas un « non ».
        if (roomId && value !== null && value !== undefined) {
          await db.rooms.update(roomId, { raceMode: Boolean(value) });
        }
        continue;
      }
      const st = parseClientStatusKey(key);
      if (st) {
        await this.storeClientStatus(st.slot, readClientStatus(value));
        continue;
      }
      if (!parseHintsKey(key) || !Array.isArray(value)) continue;
      answered = true;
      hints.push(...(value as Hint[]));
    }
    if (answered) this.hintsFromServer.set(true);
    if (hints.length) await this.ingestHints(hints, now);
  }

  private async onSetReply(pkt: SetReplyPacket, now: number): Promise<void> {
    const st = parseClientStatusKey(pkt.key);
    if (st) {
      await this.storeClientStatus(st.slot, readClientStatus(pkt.value));
      return;
    }
    if (!parseHintsKey(pkt.key) || !Array.isArray(pkt.value)) return;
    this.hintsFromServer.set(true);
    await this.ingestHints(pkt.value as Hint[], now);
  }

  /** Derives de la ligne, pas du `dedupKey` : les anciens hints portent un hachage de minute. */
  private async knownHintSuffixes(roomId: string): Promise<Set<string>> {
    const rows = await db.events
      .where('[roomId+kind+ts]')
      .between([roomId, 'hint', Dexie.minKey], [roomId, 'hint', Dexie.maxKey])
      .toArray();
    const out = new Set<string>();
    for (const r of rows) {
      if (r.srcSlot === null || r.locationId === null) continue;
      out.add(hintDedupSuffix(r.team, r.srcSlot, r.locationId));
    }
    return out;
  }

  private async ingestHints(hints: readonly Hint[], now: number): Promise<number> {
    const roomId = this.currentRoomId;
    const sessionId = this.sessionId;
    if (!roomId || sessionId === null) return 0;

    // Le data storage ne garde aucune date : bornes depuis l'ouverture de la room.
    const tsLower = this.roomCreatedAt ?? now;
    const gaps = computeHintGaps({
      team: this.team,
      hints,
      knownSuffixes: await this.knownHintSuffixes(roomId),
      tsLower,
      tsUpper: now,
    });
    if (!gaps.length) return 0;

    const rows: ApEvent[] = gaps.map((g) => ({
      roomId,
      ts: g.ts,
      tsPrecision: 'approx' as const,
      tsLower: g.tsLower,
      tsUpper: g.tsUpper,
      kind: 'hint' as const,
      team: this.team,
      srcSlot: g.srcSlot,
      dstSlot: g.dstSlot,
      itemId: g.itemId,
      locationId: g.locationId,
      itemFlags: g.itemFlags,
      text: '',
      segments: [],
      tags: null,
      sessionId,
      raw: { fromHintStorage: true, entrance: g.entrance },
      dedupKey: `${roomId}|${g.dedupSuffix}`,
    }));
    rows.forEach((row, i) => this.renderStoredHint(row, gaps[i].entrance));

    try {
      await db.events.bulkAdd(rows);
    } catch (e) {
      if (!(e instanceof Dexie.BulkError)) throw e;
    }
    await this.loadHistory(roomId);
    return rows.length;
  }

  /** Seules les lignes fabriquees par l'outil se recomposent ; celles du serveur gardent leurs segments. */
  relabel(row: ApEvent): RenderedSegment[] {
    if (row.kind === 'death') {
      const packet = row.raw as BouncedPacket | null;
      if (!packet || !isDeathLink(packet)) return row.segments;
      const draft = buildDeathDraft({ packet, receivedAt: row.ts, slotNames: this.names.slotNames() });
      const label = draft.slot !== null ? this.names.playerName(draft.slot) : null;
      return renderDeath(draft, label, this.i18n.t).segments;
    }
    if (row.tsPrecision !== 'approx') return row.segments;
    const copy: ApEvent = { ...row };
    if (row.kind === 'hint') {
      const entrance = (row.raw as { entrance?: string } | null)?.entrance ?? '';
      this.renderStoredHint(copy, entrance);
    } else if (row.kind === 'item') {
      this.renderApproxRow(copy);
    } else {
      return row.segments;
    }
    return copy.segments;
  }

  private between(key: 'line.hint.title' | 'line.granted.title' | 'line.gap.title', row: ApEvent): string {
    return this.i18n.t(key, {
      from: this.i18n.datetime(row.tsLower!),
      to: this.i18n.datetime(row.tsUpper!),
    });
  }

  private renderStoredHint(row: ApEvent, entrance: string): void {
    const cls = itemClassOf(row.itemFlags);
    const marker = cls === 'progression' || cls === 'trap' ? ITEM_CLASS_GLYPH[cls] + ' ' : '';
    const segments: RenderedSegment[] = [
      { text: '~ ', cls: 'approx-mark', title: this.between('line.hint.title', row) },
      // Le marqueur du serveur : sans lui, la recherche « hint » ne trouve pas ces lignes.
      { text: '[Hint]: ', cls: 'text' },
      {
        text: this.names.playerName(row.dstSlot!),
        cls: row.dstSlot === this.names.ownSlot ? 'player-self' : 'player-other',
      },
      { text: ' : ', cls: 'text' },
      { text: marker + this.names.itemName(row.itemId!, row.dstSlot!), cls: itemClassCss(cls) },
      { text: this.i18n.t('line.hint.isAt'), cls: 'text' },
      {
        text: this.names.playerName(row.srcSlot!),
        cls: row.srcSlot === this.names.ownSlot ? 'player-self' : 'player-other',
      },
      { text: ' — ', cls: 'text' },
      { text: this.names.locationName(row.locationId!, row.srcSlot!), cls: 'location' },
    ];
    if (entrance) segments.push({ text: ` (via ${entrance})`, cls: 'approx-note' });
    row.segments = segments;
    row.text = segments.map((s) => s.text).join('');
  }

  private renderApproxRow(row: ApEvent): void {
    // Objet accorde par le serveur : pas de location.
    if (row.locationId === null && row.dstSlot !== null && row.itemId !== null) {
      const cls = itemClassOf(row.itemFlags);
      const marker = cls === 'progression' || cls === 'trap' ? ITEM_CLASS_GLYPH[cls] + ' ' : '';
      const segments: RenderedSegment[] = [
        { text: '~ ', cls: 'approx-mark', title: this.between('line.granted.title', row) },
        {
          text: this.names.playerName(row.dstSlot),
          cls: row.dstSlot === this.names.ownSlot ? 'player-self' : 'player-other',
        },
        { text: this.i18n.t('line.received'), cls: 'text' },
        { text: marker + this.names.itemName(row.itemId, row.dstSlot), cls: itemClassCss(cls) },
        { text: this.i18n.t('line.granted.note'), cls: 'approx-note' },
      ];
      row.segments = segments;
      row.text = segments.map((s) => s.text).join('');
      return;
    }

    const src = row.srcSlot ?? 0;
    const segments: RenderedSegment[] = [
      { text: '~ ', cls: 'approx-mark', title: this.between('line.gap.title', row) },
      { text: this.names.playerName(src), cls: src === this.names.ownSlot ? 'player-self' : 'player-other' },
    ];

    if (row.itemId !== null && row.dstSlot !== null) {
      const cls = itemClassOf(row.itemFlags);
      const marker = cls === 'progression' || cls === 'trap' ? ITEM_CLASS_GLYPH[cls] + ' ' : '';
      segments.push(
        { text: this.i18n.t('line.sent'), cls: 'text' },
        { text: marker + this.names.itemName(row.itemId, row.dstSlot), cls: itemClassCss(cls) },
        { text: this.i18n.t('line.to'), cls: 'text' },
        {
          text: this.names.playerName(row.dstSlot),
          cls: row.dstSlot === this.names.ownSlot ? 'player-self' : 'player-other',
        },
      );
    } else {
      segments.push({ text: this.i18n.t('line.checked'), cls: 'text' });
    }

    segments.push(
      { text: ' (', cls: 'text' },
      { text: this.names.locationName(row.locationId!, src), cls: 'location' },
      { text: ')', cls: 'text' },
      { text: this.i18n.t('line.gap.note'), cls: 'approx-note' },
    );

    row.segments = segments;
    row.text = segments.map((s) => s.text).join('');
  }

  private onRefused(pkt: ConnectionRefusedPacket): void {
    const errors = pkt.errors ?? ['inconnu'];
    this.refusal.set(errors);
    // Le meme Connect serait refuse a nouveau, code inconnu compris : retenter ne fait que boucler.
    this.socket.fail(`Connexion refusee : ${errors.join(', ')}`);
  }

  private async onRoomUpdate(pkt: RoomUpdatePacket): Promise<void> {
    if (pkt.players) this.publishPlayers(pkt.players);
    if (pkt.permissions) {
      this.permissions.set(pkt.permissions);
      const roomId = this.currentRoomId;
      if (roomId) await db.rooms.update(roomId, { permissions: pkt.permissions });
    }
    const before = this.hintPoints();
    if (pkt.hint_points !== undefined) this.hintPoints.set(pkt.hint_points);
    if (typeof pkt.hint_cost === 'number') {
      this.roomHintCost = pkt.hint_cost;
      const roomId = this.currentRoomId;
      if (roomId) await db.rooms.update(roomId, { hintCost: pkt.hint_cost });
    }
    await this.observeHintCost(pkt, before);
  }

  /** Une baisse n'est pure que sans `checked_locations` dans le meme `RoomUpdate`. */
  private async observeHintCost(pkt: RoomUpdatePacket, before: number): Promise<void> {
    const roomId = this.currentRoomId;
    const slot = this.ownSlot();
    if (!roomId || slot === null) return;
    if (typeof pkt.hint_points !== 'number') return;
    if (pkt.checked_locations?.length) return;

    const drop = before - pkt.hint_points;
    if (drop <= 0) return;

    const stats = await db.slotStats.get([roomId, slot]);
    const total = stats?.totalLocations ?? null;
    const pct = this.roomHintCost;
    if (total === null || pct === null) return;

    const observed = validateObservedHintCost({
      drop,
      computedCost: Math.ceil((pct / 100) * total),
    });
    if (observed === null || !stats) return;
    await this.storeObservedHintCost(stats, observed, pct);
  }

  private async observeHintCostReply(text: string): Promise<void> {
    const roomId = this.currentRoomId;
    const slot = this.ownSlot();
    const pct = this.roomHintCost;
    if (!roomId || slot === null || pct === null) return;
    const stats = await db.slotStats.get([roomId, slot]);
    const total = stats?.totalLocations ?? null;
    if (!stats || total === null) return;
    const observed = readHintCostReply({
      text,
      balance: this.hintPoints(),
      computedCost: Math.ceil((pct / 100) * total),
    });
    if (observed === null) return;
    await this.storeObservedHintCost(stats, observed, pct);
  }

  private async storeObservedHintCost(stats: SlotStats, observed: number, pct: number): Promise<void> {
    if (stats.hintCostObserved === observed && stats.hintCostObservedFor === pct) {
      this.hintCostObserved.set(observed);
      return;
    }
    // Cle composite, que `update` ne sait pas typer.
    await db.slotStats.put({ ...stats, hintCostObserved: observed, hintCostObservedFor: pct });
    this.hintCostObserved.set(observed);
  }

  private publishPlayers(players: { slot: number; name: string; alias: string }[]): void {
    this.players.set(
      players.map((p) => ({
        slot: p.slot,
        name: p.alias || p.name,
        game: this.names.gameOf(p.slot) ?? '?',
      })),
    );
  }

  private onPrintJson(packet: PrintJsonPacket, ts: number): void {
    if (!this.resolverReady) {
      this.pending.push({ packet, ts });
      return;
    }
    this.enqueue(packet, ts);
  }

  private tryReleasePending(): void {
    if (this.missingDataPackages().length > 0 || this.sessionId === null) return;
    this.resolverReady = true;
    const queued = this.pending;
    this.pending = [];
    for (const { packet, ts } of queued) this.enqueue(packet, ts);
  }

  /** Le serveur ne garde aucune mort : ecrite aussitot, sinon perdue. */
  private onBounced(packet: BouncedPacket, now: number): void {
    if (!this.currentRoomId || this.sessionId === null) return;
    if (!isDeathLink(packet)) return;

    const draft = buildDeathDraft({
      packet,
      receivedAt: now,
      slotNames: this.names.slotNames(),
    });
    const rendered = renderDeath(
      draft,
      draft.slot !== null ? this.names.playerName(draft.slot) : null,
      this.i18n.t,
    );

    this.writeQueue.push({
      roomId: this.currentRoomId,
      ts: draft.ts,
      // Sans `time` utilisable, `ts` retombe sur la reception, toujours `exact`.
      tsPrecision: 'exact',
      tsLower: null,
      tsUpper: null,
      kind: rendered.kind,
      team: rendered.team,
      srcSlot: rendered.srcSlot,
      dstSlot: rendered.dstSlot,
      itemId: rendered.itemId,
      locationId: rendered.locationId,
      itemFlags: rendered.itemFlags,
      text: rendered.text,
      segments: rendered.segments,
      tags: rendered.tags,
      sessionId: this.sessionId,
      raw: packet,
      dedupKey: `${this.currentRoomId}|${rendered.dedupSuffix}`,
    });
  }

  private enqueue(packet: PrintJsonPacket, ts: number): void {
    const draft = decodePrintJson(packet, this.names, ts);
    this.writeQueue.push({
      roomId: this.currentRoomId!,
      ts,
      tsPrecision: 'exact',
      tsLower: null,
      tsUpper: null,
      kind: draft.kind,
      team: draft.team,
      srcSlot: draft.srcSlot,
      dstSlot: draft.dstSlot,
      itemId: draft.itemId,
      locationId: draft.locationId,
      itemFlags: draft.itemFlags,
      text: draft.text,
      segments: draft.segments,
      tags: draft.tags,
      sessionId: this.sessionId!,
      raw: packet,
      dedupKey: `${this.currentRoomId}|${draft.dedupSuffix}`,
    });
    this.updatePresenceFrom(draft, ts);
    // `!hint` seul y donne le cout exact.
    if (draft.kind === 'command' && packet.type === 'CommandResult') {
      void this.guard(this.i18n.t('info.hintCost'), this.observeHintCostReply(draft.text));
    }
  }

  /** Sessions closes seulement ; la courante est suivie en direct. */
  private async rebuildPresence(
    roomId: string,
    sessions: CaptureSession[],
    pkt: ConnectedPacket,
  ): Promise<void> {
    const closed = sessions.filter((s) => s.endedAt !== null || s.lastHeartbeatAt > s.startedAt);
    if (!closed.length) return;

    const written = await rebuildPresenceRows({
      roomId,
      team: pkt.team,
      slots: pkt.players.map((p) => p.slot),
      sessions: closed,
      textClientSlots: this.textClientSlots,
    });
    this.presenceRebuilt.set(written);
  }

  /** Chaque passage diffuse un Join et un Part a toute la room : seulement sur un trou. */
  private async maybeSweep(roomId: string, ownSlot: number, now: number): Promise<void> {
    const enabled = await this.loadSweepEnabled(roomId);

    const lastRow = await db.settings.get(LAST_SWEEP_KEY(roomId));
    const lastSweepAt = typeof lastRow?.value === 'number' ? lastRow.value : null;

    const decision = decideSweep(this.priorCoverage, lastSweepAt, now, enabled);
    if (!decision.sweep) {
      this.sweep.set({
        running: false,
        total: 0,
        done: 0,
        current: null,
        created: 0,
        itemsRecovered: 0,
        contentFilled: 0,
        failed: [],
        reason: decision.reason,
        gapMs: decision.gapMs,
      });
      return;
    }
    await this.runSweep(roomId, ownSlot, now, decision);
  }

  private async runSweep(
    roomId: string,
    ownSlot: number | null,
    now: number,
    decision: Pick<SweepDecision, 'reason' | 'gapMs'>,
  ): Promise<void> {
    const token = ++this.sweepToken;
    const targets = selectSweepTargets(this.slotInfo, ownSlot);
    const tsLower = lastCoveredBefore(this.priorCoverage, now) ?? this.roomCreatedAt ?? now;
    const url = this.socket.url ?? candidateUrls(this.params!.host, this.params!.port)[0];

    const progress: SweepProgress = {
      running: true,
      total: targets.length,
      done: 0,
      current: null,
      created: 0,
      itemsRecovered: 0,
      contentFilled: 0,
      failed: [],
      reason: decision.reason,
      gapMs: decision.gapMs,
    };
    this.sweep.set({ ...progress });

    for (const target of targets) {
      if (token !== this.sweepToken) return;
      progress.current = target.name;
      this.sweep.set({ ...progress });

      const outcome = await scoutSlot({
        url,
        slotName: target.name,
        password: this.params!.password,
        uuid: this.uuid(),
        // `resolved` et non `known` : une ligne ecrite sans contenu doit etre re-scoutee.
        selectLocations: async (checked, slot) => {
          const { resolved } = await this.locationIdsOf(roomId, slot);
          return selectScoutTargets({ checkedLocations: checked, resolvedLocationIds: resolved });
        },
      });

      if (outcome.error) {
        progress.failed.push({ slot: target.name, error: outcome.error });
        if (outcome.fatal) break;
      } else if (outcome.checkedLocations && outcome.slot !== undefined) {
        await this.recordSlotTotals(
          roomId,
          outcome.slot,
          outcome.checkedLocations,
          outcome.missingLocations ?? [],
          now,
          outcome.hintPoints ?? null,
        );
        const res = await this.writeGapChecks({
          roomId,
          team: outcome.team ?? 0,
          slot: outcome.slot,
          checkedLocations: outcome.checkedLocations,
          tsLower,
          tsUpper: now,
          items: outcome.items,
        });
        progress.created += res.created;

        if (outcome.items?.size) {
          progress.contentFilled += await this.patchScoutedRows({
            roomId,
            team: outcome.team ?? 0,
            slot: outcome.slot,
            items: outcome.items,
          });
        }

        if (outcome.receivedItems?.length) {
          const got = await this.writeReceivedItems({
            roomId,
            team: outcome.team ?? 0,
            dstSlot: outcome.slot,
            items: outcome.receivedItems,
            tsLower,
            tsUpper: now,
          });
          progress.itemsRecovered += got.created;
        }
      }

      progress.done++;
      this.sweep.set({ ...progress });
      await new Promise((r) => setTimeout(r, SWEEP_DELAY_MS));
    }

    if (token !== this.sweepToken) return;
    progress.running = false;
    progress.current = null;
    this.sweep.set({ ...progress });

    await db.settings.put({ key: LAST_SWEEP_KEY(roomId), value: now });
    if (progress.created || progress.itemsRecovered || progress.contentFilled) {
      await this.loadHistory(roomId);
      await this.refreshCoverage(roomId, Date.now());
    }
  }

  private updatePresenceFrom(draft: EventDraft, ts: number): void {
    const slot = draft.srcSlot;
    if (this.currentRoomId === null || slot === null) return;
    if (draft.kind === 'join') this.tracker.join(slot, draft.tags, ts);
    // Le paquet Part ne porte pas de tags.
    else if (draft.kind === 'part') this.tracker.part(slot, ts);
    else if (ACTIVITY_KINDS.has(draft.kind)) this.tracker.activity(slot, ts);
    else return;
    this.publishPresence();
  }

  /** Rien dans le protocole ne distingue un client texte : c'est une declaration. */
  async toggleTextClientSlot(slot: number): Promise<void> {
    const roomId = this.currentRoomId;
    if (!roomId) return;
    const next = new Set(this.textClientSlots);
    if (!next.delete(slot)) next.add(slot);
    this.textClientSlots = next;
    await db.settings.put({ key: TEXT_CLIENT_KEY(roomId), value: [...next] });
    this.tracker.setTextClientSlots(next, Date.now());
    this.publishPresence();
  }

  private async loadTextClientSlots(roomId: string): Promise<Set<number>> {
    const row = await db.settings.get(TEXT_CLIENT_KEY(roomId));
    return new Set(Array.isArray(row?.value) ? (row.value as number[]) : []);
  }

  private onPresenceOp(op: PresenceOp): void {
    if (op.type === 'open') {
      const p = db.presence.add(op.interval) as unknown as Promise<number>;
      this.presenceIds.set(op.interval, p);
      return;
    }
    // La fermeture peut preceder la resolution de l'insertion.
    const pending = this.presenceIds.get(op.interval);
    if (!pending) return;
    void pending.then((id) => db.presence.update(id, { to: op.to }));
  }

  private publishPresence(): void {
    const map: Record<number, SlotPresenceView> = {};
    for (const p of this.tracker.snapshot()) {
      map[p.slot] = {
        state: p.state,
        players: p.players,
        observers: p.observers,
        textClient: p.textClient,
      };
    }
    this.presence.set(map);
  }

  private startFlushLoop(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (!this.writeQueue.length) return;
    const batch = this.writeQueue;
    this.writeQueue = [];
    let stored = batch;
    try {
      await db.events.bulkAdd(batch);
    } catch (e) {
      if (!(e instanceof Dexie.BulkError)) throw e;
      // Une ligne refusee par `&dedupKey` est deja en base : l'afficher la ferait disparaitre au rechargement.
      stored = storedRows(batch, e.failuresByPos);
    }
    if (stored.length) this.appendToFeed(stored);
  }

  /** Tout le journal, pas `feed`. Une reponse de plus que `SEARCH_LIMIT` signale la coupe. */
  async searchFeed(query: string): Promise<ApEvent[]> {
    const roomId = this.roomId();
    const q = normalizeQuery(query);
    if (!roomId || !q) return [];
    const rows = await db.events
      .where('[roomId+ts]')
      .between([roomId, Dexie.minKey], [roomId, Dexie.maxKey])
      .reverse()
      .filter((e) => matchesSearch(e, q))
      .limit(SEARCH_LIMIT + 1)
      .toArray();
    rows.reverse();
    return rows;
  }

  private appendToFeed(rows: ApEvent[]): void {
    const next = [...this.feed(), ...rows];
    this.feed.set(next.length > FEED_LIMIT ? next.slice(next.length - FEED_LIMIT) : next);
    this.eventCount.update((n) => n + rows.length);
  }

  private replaceInFeed(rows: ApEvent[]): void {
    const byKey = new Map(rows.map((r) => [r.dedupKey, r]));
    let touched = false;
    const next = this.feed().map((e) => {
      const patch = byKey.get(e.dedupKey);
      if (!patch) return e;
      touched = true;
      return { ...e, ...patch };
    });
    if (touched) this.feed.set(next);
  }

  async reloadFromDb(roomId: string, opts: { withFeed?: boolean } = {}): Promise<void> {
    if (this.roomId() === null) {
      this.roomId.set(roomId);
      void this.loadSweepEnabled(roomId);
      const room = await db.rooms.get(roomId);
      if (room?.players?.length && this.players().length === 0) {
        this.players.set(room.players.map((p) => ({ slot: p.slot, name: p.name, game: p.game })));
        if (this.ownSlot() === null) await this.recoverOwnSlot(roomId, room.players);
      }
    }
    if (opts.withFeed === false) {
      this.feed.set([]);
      this.eventCount.set(await this.countEvents(roomId));
    } else {
      await this.loadHistory(roomId);
    }
    await this.refreshCoverage(roomId, Date.now());
  }

  /** Sessions importees ecartees : leur `connectedAsSlot` est celui de l'exporteur. */
  private async recoverOwnSlot(
    roomId: string,
    players: readonly { slot: number; name: string }[],
  ): Promise<void> {
    const sessions = await db.sessions.where('roomId').equals(roomId).toArray();
    const mine = sessions
      .filter((s) => s.importedFrom === undefined && s.connectedAsSlot)
      .sort((a, b) => b.startedAt - a.startedAt);
    const name = mine[0]?.connectedAsSlot;
    if (!name) return;
    const match = players.find((p) => p.name === name);
    if (match) this.ownSlot.set(match.slot);
  }

  private countEvents(roomId: string): Promise<number> {
    return db.events.where('roomId').equals(roomId).count();
  }

  private async loadHistory(roomId: string): Promise<void> {
    const recent = await db.events
      .where('[roomId+ts]')
      .between([roomId, Dexie.minKey], [roomId, Dexie.maxKey])
      .reverse()
      .limit(FEED_LIMIT)
      .toArray();
    recent.reverse();
    this.feed.set(recent);
    this.eventCount.set(await this.countEvents(roomId));
  }

  private async refreshCoverage(roomId: string, now: number): Promise<void> {
    const sessions = await db.sessions.where('roomId').equals(roomId).toArray();
    const cov = mergeCoverage(sessions, now);
    this.coverage.set(cov);
    const room = await db.rooms.get(roomId);
    const from = room?.createdAt ?? cov[0]?.from ?? now;
    this.gapTotalMs.set(gapDuration(cov, from, now));
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.sessionId === null) return;
      void db.sessions.update(this.sessionId, { lastHeartbeatAt: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async closeSession(reason: CaptureSession['closeReason'], endedAt = Date.now()): Promise<void> {
    if (this.sessionId === null) return;
    const id = this.sessionId;
    this.sessionId = null;
    // Au-dela de la session : pas de donnees, ce qui n'est pas `offline`.
    this.tracker.end(endedAt);
    this.publishPresence();
    await db.sessions.update(id, { endedAt, closeReason: reason });
  }

  /**
   * Un seul onglet capture : un second prendrait la session vivante du premier pour une orpheline et la fermerait.
   * Le verrou se libere a la fermeture de l'onglet, et l'onglet suivant en file le recoit.
   */
  private async claimCapture(): Promise<void> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks) {
      const hold = () => new Promise<never>(() => undefined);
      const granted = await new Promise<boolean>((resolve) => {
        void locks.request(CAPTURE_LOCK, { ifAvailable: true }, (lock) => {
          resolve(lock !== null);
          return lock ? hold() : undefined;
        });
      });
      if (!granted) {
        this.captureOwner.set(false);
        await new Promise<void>((resolve) => {
          void locks.request(CAPTURE_LOCK, () => {
            resolve();
            return hold();
          });
        });
      }
    }
    this.captureOwner.set(true);
    await this.finalizeOrphanRecords();
  }

  /** Un onglet ferme brutalement laisse session et intervalles ouverts. */
  private async finalizeOrphanRecords(): Promise<void> {
    const orphans = await db.sessions.filter((s) => s.endedAt === null).toArray();
    for (const s of orphans) {
      await db.sessions.update(s.id!, { endedAt: s.lastHeartbeatAt, closeReason: 'crash-inferred' });
      const open = await db.presence.filter((i) => i.roomId === s.roomId && i.to === null).toArray();
      for (const i of open) {
        await db.presence.update(i.id!, { to: Math.max(s.lastHeartbeatAt, i.from) });
      }
    }
  }

  private stopLoops(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** Stable : le serveur s'en sert pour reconnaitre une reconnexion. */
  private uuid(): string {
    const key = 'vigipelago.uuid';
    let v = localStorage.getItem(key);
    if (!v) {
      v = crypto.randomUUID();
      localStorage.setItem(key, v);
    }
    return v;
  }
}
