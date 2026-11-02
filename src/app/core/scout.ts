import { VIGIPELAGO_TAG } from '../protocol/tags';
import {
  CLIENT_VERSION,
  ITEMS_HANDLING_ALL,
  type ConnectedPacket,
  type ConnectionRefusedPacket,
  type LocationInfoPacket,
  type NetworkItem,
  type ReceivedItemsPacket,
  type ServerPacket,
} from '../protocol/types';

/** Chaque passage diffuse un Join et un Part a toute la room : seulement sur un vrai trou. */

export interface ScoutOutcome {
  slotName: string;
  slot?: number;
  team?: number;
  checkedLocations?: number[];
  missingLocations?: number[];
  /** Un instantane : ne vaut que de l'instant de la connexion. */
  hintPoints?: number;
  items?: Map<number, NetworkItem>;
  /** Absent si le slot n'a rien recu : le serveur n'envoie alors aucun `ReceivedItems`. */
  receivedItems?: NetworkItem[];
  error?: string;
  /** Se reproduira sur tous les slots : mot de passe, version. */
  fatal?: boolean;
}

export interface ScoutOptions {
  url: string;
  slotName: string;
  password: string;
  uuid: string;
  /** Un tableau vide ferme la connexion immediatement. */
  selectLocations: (checked: number[], slot: number, team: number) => Promise<number[]>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const LOCATION_INFO_TIMEOUT_MS = 5_000;
/** Un slot qui n'a rien recu n'envoie aucun paquet : borne l'attente. */
const RECEIVED_ITEMS_GRACE_MS = 1_500;
const FATAL_ERRORS = new Set(['InvalidPassword', 'IncompatibleVersion']);

export function scoutSlot(opts: ScoutOptions): Promise<ScoutOutcome> {
  const { url, slotName, password, uuid, selectLocations } = opts;

  return new Promise<ScoutOutcome>((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      resolve({ slotName, error: String(e) });
      return;
    }

    let settled = false;
    let expectedItems = 0;
    let pendingSelection = false;
    let pendingLocations = false;
    let pendingReceived = false;
    const outcome: ScoutOutcome = { slotName };

    const finish = (extra?: Partial<ScoutOutcome>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      clearTimeout(infoTimer);
      clearTimeout(receivedTimer);
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* deja ferme */
      }
      resolve({ ...outcome, ...extra });
    };

    const overallTimer = setTimeout(
      () => finish({ error: 'delai depasse' }),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    let infoTimer: ReturnType<typeof setTimeout>;
    let receivedTimer: ReturnType<typeof setTimeout>;

    const maybeFinish = (): void => {
      if (pendingSelection || pendingLocations || pendingReceived) return;
      finish();
    };

    ws.onerror = () => {
      /* onclose suit toujours. */
    };
    ws.onclose = () => finish({ error: outcome.checkedLocations ? undefined : 'connexion fermee' });

    ws.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      const packets = (Array.isArray(parsed) ? parsed : [parsed]) as ServerPacket[];

      for (const p of packets) {
        if (p.cmd === 'RoomInfo') {
          ws.send(
            JSON.stringify([
              {
                cmd: 'Connect',
                password: password || null,
                game: '',
                name: slotName,
                uuid,
                version: CLIENT_VERSION,
                // Non nul, sinon pas de liste des objets recus.
                items_handling: ITEMS_HANDLING_ALL,
                tags: ['TextOnly', VIGIPELAGO_TAG],
                slot_data: false,
              },
            ]),
          );
        } else if (p.cmd === 'ConnectionRefused') {
          const errors = (p as ConnectionRefusedPacket).errors ?? ['inconnu'];
          finish({ error: errors.join(', '), fatal: errors.some((e) => FATAL_ERRORS.has(e)) });
          return;
        } else if (p.cmd === 'Connected') {
          const c = p as ConnectedPacket;
          outcome.slot = c.slot;
          outcome.team = c.team;
          outcome.checkedLocations = c.checked_locations ?? [];
          outcome.missingLocations = c.missing_locations ?? [];
          if (typeof c.hint_points === 'number') outcome.hintPoints = c.hint_points;

          pendingReceived = true;
          receivedTimer = setTimeout(() => {
            pendingReceived = false;
            maybeFinish();
          }, RECEIVED_ITEMS_GRACE_MS);

          pendingSelection = true;
          void selectLocations(outcome.checkedLocations, c.slot, c.team).then((wanted) => {
            if (settled) return;
            pendingSelection = false;
            if (!wanted.length) {
              maybeFinish();
              return;
            }
            expectedItems = wanted.length;
            outcome.items = new Map();
            pendingLocations = true;
            // 0 : ni hint cree, ni points depenses.
            ws.send(JSON.stringify([{ cmd: 'LocationScouts', locations: wanted, create_as_hint: 0 }]));
            infoTimer = setTimeout(() => {
              pendingLocations = false;
              maybeFinish();
            }, LOCATION_INFO_TIMEOUT_MS);
          });
        } else if (p.cmd === 'LocationInfo') {
          const info = p as LocationInfoPacket;
          for (const item of info.locations ?? []) outcome.items?.set(item.location, item);
          if ((outcome.items?.size ?? 0) >= expectedItems) {
            pendingLocations = false;
            clearTimeout(infoTimer);
            maybeFinish();
          }
        } else if (p.cmd === 'ReceivedItems') {
          const r = p as ReceivedItemsPacket;
          // Seul l'index 0 est la liste complete.
          if (r.index !== 0) continue;
          outcome.receivedItems = r.items ?? [];
          pendingReceived = false;
          clearTimeout(receivedTimer);
          maybeFinish();
        }
      }
    };
  });
}
