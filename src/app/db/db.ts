import Dexie, { type EntityTable } from 'dexie';
// Type seul : `profiles.ts` importe d'ici, le cycle n'existe pas a l'execution.
import type { ConnectionProfile } from '../core/profiles';

/** Hors le `Bounce` DeathLink, qui porte son heure, le protocole n'horodate rien : l'heure est celle de la reception. */
export type TsPrecision = 'exact' | 'approx';

export type EventKind =
  | 'item'
  | 'hint'
  | 'join'
  | 'part'
  | 'chat'
  | 'server'
  | 'goal'
  | 'release'
  | 'collect'
  | 'tags'
  | 'countdown'
  | 'command'
  | 'tutorial'
  | 'death'
  | 'system';

export interface RenderedSegment {
  text: string;
  cls: string;
  title?: string;
}

export interface ApEvent {
  id?: number;
  roomId: string;
  ts: number;
  tsPrecision: TsPrecision;
  /** Non nulles seulement si `tsPrecision === 'approx'`. */
  tsLower: number | null;
  tsUpper: number | null;
  kind: EventKind;
  team: number;
  /** Le monde qui contenait la location, pas forcement celui qui recoit. */
  srcSlot: number | null;
  dstSlot: number | null;
  itemId: number | null;
  locationId: number | null;
  itemFlags: number | null;
  text: string;
  segments: RenderedSegment[];
  tags: string[] | null;
  sessionId: number;
  raw: unknown;
  dedupKey: string;
}

export interface CaptureSession {
  id?: number;
  roomId: string;
  connectedAsSlot: string;
  startedAt: number;
  endedAt: number | null;
  lastHeartbeatAt: number;
  closeReason: 'live' | 'user' | 'socket-error' | 'unload' | 'crash-inferred';
  appVersion: string;
  importedFrom?: string;
}

export interface Room {
  roomId: string;
  seedName: string;
  label: string;
  host: string;
  port: number;
  players: { team: number; slot: number; name: string; alias: string; game: string }[];
  firstSeenAt: number;
  /** Ne pas lire : le protocole ne date pas l'ouverture d'une room (`RoomInfo.time` est l'heure du serveur). */
  createdAt: number | null;
  lastSeenAt: number;
  /** Un pourcentage du total d'emplacements du slot, pas des points. */
  hintCost: number | null;
  locationCheckPoints: number | null;
  // Absents sur les anciennes rooms : valent « inconnu », jamais une valeur par defaut.
  serverVersion?: string | null;
  generatorVersion?: string | null;
  permissions?: Record<string, number> | null;
  /** Un mot de passe est-il exige. Jamais le mot de passe. */
  password?: boolean | null;
  raceMode?: boolean | null;
}

export interface CachedGamePackage {
  game: string;
  checksum: string;
  itemIdToName: Record<number, string>;
  locationIdToName: Record<number, string>;
}

export interface LocationSnapshot {
  id?: number;
  roomId: string;
  team: number;
  slot: number;
  ts: number;
  sessionId: number;
  /** Les ids vont jusqu'a 2^53-1 : pas de tableau type. */
  checkedLocations: number[];
}

export interface PresenceInterval {
  id?: number;
  roomId: string;
  team: number;
  slot: number;
  from: number;
  to: number | null;
  /** `unknown` n'est pas `offline` : aucune information. */
  state: 'online' | 'observer' | 'offline' | 'unknown';
  source: 'observed' | 'assumed';
}

/** Le serveur ne donne ces totaux que pour le slot connecte : les autres viennent du balayage. */
export interface SlotStats {
  roomId: string;
  slot: number;
  totalLocations: number;
  /** Un instantane : ne se relit pas a un instant passe. */
  checkedFromServer: number;
  /** Celui des autres slots date du dernier balayage. `null` si jamais vu. */
  hintPoints: number | null;
  hintCostObserved: number | null;
  /** S'il differe du `hintCost` actuel, l'observation est perimee. */
  hintCostObservedFor: number | null;
  /** `30` = objectif declare par le client, jamais calcule. `null` : cle jamais ecrite. */
  status?: number | null;
  updatedAt: number;
}

export interface Setting {
  key: string;
  value: unknown;
}

export type { ConnectionProfile } from '../core/profiles';

export class VigipelagoDb extends Dexie {
  events!: EntityTable<ApEvent, 'id'>;
  sessions!: EntityTable<CaptureSession, 'id'>;
  rooms!: EntityTable<Room, 'roomId'>;
  dataPackages!: EntityTable<CachedGamePackage, 'game'>;
  snapshots!: EntityTable<LocationSnapshot, 'id'>;
  presence!: EntityTable<PresenceInterval, 'id'>;
  settings!: EntityTable<Setting, 'key'>;
  slotStats!: EntityTable<SlotStats, 'roomId'>;
  profiles!: EntityTable<ConnectionProfile, 'id'>;

  constructor() {
    super('vigipelago');
    this.version(1).stores({
      events:
        '++id, &dedupKey, [roomId+ts], [roomId+srcSlot+ts], [roomId+dstSlot+ts], [roomId+kind+ts], [roomId+sessionId]',
      sessions: '++id, roomId, startedAt, [roomId+startedAt]',
      rooms: 'roomId, lastSeenAt',
      dataPackages: 'game, [game+checksum]',
      snapshots: '++id, [roomId+slot+ts]',
      presence: '++id, [roomId+slot+from]',
      settings: 'key',
    });

    this.version(2).stores({
      slotStats: '[roomId+slot], roomId',
    });

    // Le mot de passe n'est pas dans le schema et ne doit pas y entrer.
    this.version(3).stores({
      profiles: '++id, &targetKey, roomId, lastUsedAt',
    });

    this.version(4).stores({
      wikiNames: 'game, updatedAt',
    });

    // `targetKey` n'est plus unique : un serveur relance sert une autre partie.
    this.version(5).stores({
      profiles: '++id, targetKey, roomId, lastUsedAt',
    });

    this.version(6).stores({
      wikiNames: null,
    });

    // Chaque index coute une ecriture par `put` ; seuls restent ceux qu'une requete interroge.
    this.version(7).stores({
      events: '++id, &dedupKey, [roomId+ts], [roomId+srcSlot+ts], [roomId+dstSlot+ts], [roomId+kind+ts]',
      sessions: '++id, roomId',
      rooms: 'roomId',
      dataPackages: 'game',
      profiles: '++id, targetKey',
    });
  }
}

export const db = new VigipelagoDb();
