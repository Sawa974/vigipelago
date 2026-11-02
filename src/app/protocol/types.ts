export interface NetworkVersion {
  major: number;
  minor: number;
  build: number;
  class: 'Version';
}

export interface NetworkPlayer {
  team: number;
  slot: number;
  alias: string;
  name: string;
}

export interface NetworkSlot {
  name: string;
  game: string;
  /** 0 = spectator, 1 = player, 2 = group */
  type: number;
  group_members: number[];
}

export interface NetworkItem {
  item: number;
  location: number;
  /** Le monde de la location, sauf dans `ReceivedItems` ou c'est le monde d'origine. */
  player: number;
  /** Bitmask : 1 progression, 2 useful, 4 trap. */
  flags: number;
}

/** Les bits 1 et 2 exigent le bit 0 ; non nul, il declenche le rejeu `ReceivedItems` d'index 0. */
export const ITEMS_HANDLING_NONE = 0b000;
export const ITEMS_HANDLING_ALL = 0b111;

export const ITEM_FLAG_PROGRESSION = 0b001;
export const ITEM_FLAG_USEFUL = 0b010;
export const ITEM_FLAG_TRAP = 0b100;

export type JSONMessagePartType =
  | 'text'
  | 'player_id'
  | 'player_name'
  | 'item_id'
  | 'item_name'
  | 'location_id'
  | 'location_name'
  | 'entrance_name'
  | 'hint_status'
  | 'color';

export interface JSONMessagePart {
  type?: JSONMessagePartType;
  text?: string;
  color?: string;
  flags?: number;
  /** Pour les types *_id : le slot dont le jeu resout l'identifiant. */
  player?: number;
  hint_status?: number;
}

export type PrintJsonType =
  | 'ItemSend'
  | 'ItemCheat'
  | 'Hint'
  | 'Join'
  | 'Part'
  | 'Chat'
  | 'ServerChat'
  | 'Tutorial'
  | 'TagsChanged'
  | 'CommandResult'
  | 'AdminCommandResult'
  | 'Goal'
  | 'Release'
  | 'Collect'
  | 'Countdown';

export interface RoomInfoPacket {
  cmd: 'RoomInfo';
  version: NetworkVersion;
  generator_version: NetworkVersion;
  tags: string[];
  password: boolean;
  permissions: Record<string, number>;
  hint_cost: number;
  location_check_points: number;
  games?: string[];
  datapackage_checksums: Record<string, string>;
  seed_name: string;
  /** En secondes, flottant. */
  time: number;
}

export interface ConnectedPacket {
  cmd: 'Connected';
  team: number;
  slot: number;
  players: NetworkPlayer[];
  missing_locations: number[];
  checked_locations: number[];
  slot_data?: Record<string, unknown>;
  slot_info: Record<string, NetworkSlot>;
  hint_points: number;
}

export interface ConnectionRefusedPacket {
  cmd: 'ConnectionRefused';
  errors?: string[];
}

export interface RoomUpdatePacket {
  cmd: 'RoomUpdate';
  players?: NetworkPlayer[];
  checked_locations?: number[];
  hint_points?: number;
  password?: boolean;
  permissions?: Record<string, number>;
  hint_cost?: number;
}

export interface PrintJsonPacket {
  cmd: 'PrintJSON';
  data: JSONMessagePart[];
  type?: PrintJsonType;
  receiving?: number;
  item?: NetworkItem;
  found?: boolean;
  team?: number;
  slot?: number;
  tags?: string[];
  message?: string;
  countdown?: number;
}

export interface DataPackagePacket {
  cmd: 'DataPackage';
  data: { games: Record<string, GamePackage> };
}

export interface GamePackage {
  item_name_to_id: Record<string, number>;
  location_name_to_id: Record<string, number>;
  checksum: string;
}

/** `index` 0 est le rejeu complet ; ici `NetworkItem.player` est le monde d'origine. */
export interface ReceivedItemsPacket {
  cmd: 'ReceivedItems';
  index: number;
  items: NetworkItem[];
}

export interface LocationInfoPacket {
  cmd: 'LocationInfo';
  locations: NetworkItem[];
}

/** Stocke sous les deux joueurs : la cle d'un slot rend ses hints dans les deux sens. */
export interface Hint {
  receiving_player: number;
  finding_player: number;
  location: number;
  item: number;
  found: boolean;
  entrance?: string;
  item_flags?: number;
  status?: number;
}

export interface RetrievedPacket {
  cmd: 'Retrieved';
  keys: Record<string, unknown>;
}

export interface SetReplyPacket {
  cmd: 'SetReply';
  key: string;
  value: unknown;
  original_value?: unknown;
}

export interface BouncedPacket {
  cmd: 'Bounced';
  teams?: number[];
  games?: string[];
  /** Les cibles, pas l'auteur : ne dit jamais qui est mort. */
  slots?: number[];
  tags?: string[];
  operator?: string;
  data: Record<string, unknown>;
}

export interface DeathLinkData {
  /** En secondes, flottant. */
  time?: number;
  /** Contient deja le nom du joueur. */
  cause?: string;
  /** Un nom libre, pas forcement un nom de slot. */
  source?: string;
}

export interface InvalidPacketPacket {
  cmd: 'InvalidPacket';
  type: string;
  original_cmd?: string;
  text: string;
}

export type ServerPacket =
  | RoomInfoPacket
  | ConnectedPacket
  | ConnectionRefusedPacket
  | RoomUpdatePacket
  | PrintJsonPacket
  | DataPackagePacket
  | LocationInfoPacket
  | ReceivedItemsPacket
  | BouncedPacket
  | RetrievedPacket
  | SetReplyPacket
  | InvalidPacketPacket
  | { cmd: string; [k: string]: unknown };

export interface ConnectPacket {
  cmd: 'Connect';
  password: string | null;
  game: string;
  name: string;
  uuid: string;
  version: NetworkVersion;
  items_handling: number;
  tags: string[];
  slot_data: boolean;
}

export type ClientPacket =
  | ConnectPacket
  | { cmd: 'GetDataPackage'; games: string[] }
  | {
      cmd: 'LocationScouts';
      locations: number[];
      /** 0 : resoudre sans creer de hint ni consommer de points. */
      create_as_hint: 0 | 1 | 2;
    }
  | { cmd: 'Sync' }
  | { cmd: 'Bounce'; slots?: number[]; games?: string[]; tags?: string[]; data: Record<string, unknown> }
  | { cmd: 'Get'; keys: string[] }
  | { cmd: 'SetNotify'; keys: string[] }
  | { cmd: 'Say'; text: string };

/** Le serveur refuse un client plus ancien que son minimum. */
export const CLIENT_VERSION: NetworkVersion = { major: 0, minor: 6, build: 0, class: 'Version' };
