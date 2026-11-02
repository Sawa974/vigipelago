import type { PresenceInterval } from '../db/db';
import { classifyTags } from '../protocol/tags';

// Un Join porte les tags du client, un Part ne dit pas qui part : il ne decremente jamais `players`.

export type PresenceOp =
  | { type: 'open'; interval: PresenceInterval }
  | { type: 'close'; interval: PresenceInterval; to: number };

export type PresenceState = PresenceInterval['state'];

interface SlotCounters {
  /** Les notres exclus. */
  total: number;
  /** Remis a zero seulement quand `total` atteint zero. */
  players: number;
  seen: boolean;
  assumed: boolean;
}

export interface SlotPresence {
  slot: number;
  state: PresenceState;
  players: number;
  observers: number;
  textClient: boolean;
}

export class PresenceTracker {
  private readonly open = new Map<number, PresenceInterval>();
  private readonly counters = new Map<number, SlotCounters>();
  private roomId = '';
  private team = 0;
  /** Declare par l'utilisateur : un client texte a les tags d'un tracker. */
  private textClientSlots: ReadonlySet<number> = new Set();
  /** Nos Join ouvrent une dette que le prochain Part du slot eponge. */
  private readonly selfPending = new Map<number, number>();

  constructor(private readonly emit: (op: PresenceOp) => void) {}

  stateOf(slot: number): PresenceState | null {
    return this.open.get(slot)?.state ?? null;
  }

  snapshot(): SlotPresence[] {
    return [...this.open.values()].map((i) => {
      const c = this.counters.get(i.slot);
      return {
        slot: i.slot,
        state: i.state,
        players: c?.players ?? 0,
        observers: Math.max(0, (c?.total ?? 0) - (c?.players ?? 0)),
        textClient: this.textClientSlots.has(i.slot),
      };
    });
  }

  setTextClientSlots(slots: ReadonlySet<number>, ts: number): void {
    this.textClientSlots = slots;
    for (const slot of this.counters.keys()) this.reconcile(slot, ts);
  }

  /** `unknown` et non `offline` : aucune liste des clients en ligne n'existe. */
  begin(roomId: string, team: number, slots: readonly number[], ts: number): void {
    this.closeAll(ts);
    this.counters.clear();
    this.selfPending.clear();
    this.roomId = roomId;
    this.team = team;
    for (const slot of slots) {
      this.counters.set(slot, { total: 0, players: 0, seen: false, assumed: false });
      this.openInterval({ roomId, team, slot, from: ts, to: null, state: 'unknown', source: 'assumed' });
    }
  }

  join(slot: number, tags: readonly string[] | null, ts: number): void {
    if (classifyTags(tags) === 'self') {
      this.selfPending.set(slot, (this.selfPending.get(slot) ?? 0) + 1);
      return;
    }
    const c = this.ensure(slot);
    c.seen = true;
    c.assumed = false;
    c.total++;
    if (classifyTags(tags) === 'player') c.players++;
    this.reconcile(slot, ts);
  }

  part(slot: number, ts: number): void {
    const owed = this.selfPending.get(slot) ?? 0;
    if (owed > 0) {
      this.selfPending.set(slot, owed - 1);
      return;
    }
    const c = this.ensure(slot);
    c.seen = true;
    c.assumed = false;
    // Borne a zero : un Part peut arriver sans son Join.
    c.total = Math.max(0, c.total - 1);
    if (c.total === 0) c.players = 0;
    this.reconcile(slot, ts);
  }

  /** Un check corrige un `offline` mal attribue ; la prochaine observation reprend la main. */
  activity(slot: number, ts: number): void {
    const c = this.ensure(slot);
    if (c.assumed || c.players > 0) return;
    c.assumed = true;
    this.reconcile(slot, ts);
  }

  end(ts: number): void {
    this.closeAll(ts);
  }

  private derive(c: SlotCounters, slot: number): PresenceState {
    const playing = c.players + (this.textClientSlots.has(slot) ? c.total : 0);
    if (playing > 0) return 'online';
    if (c.assumed) return 'online';
    if (c.total > 0) return 'observer';
    return c.seen ? 'offline' : 'unknown';
  }

  private reconcile(slot: number, ts: number): void {
    const c = this.ensure(slot);
    const next = this.derive(c, slot);
    const nextSource = c.seen && !c.assumed ? 'observed' : 'assumed';
    const cur = this.open.get(slot);
    // Scinder aussi quand seule la source change.
    if (cur && cur.state === next && cur.source === nextSource) return;
    this.closeSlot(slot, ts);
    this.openInterval({
      roomId: this.roomId,
      team: this.team,
      slot,
      from: ts,
      to: null,
      state: next,
      source: nextSource,
    });
  }

  private ensure(slot: number): SlotCounters {
    let c = this.counters.get(slot);
    if (!c) {
      c = { total: 0, players: 0, seen: false, assumed: false };
      this.counters.set(slot, c);
    }
    return c;
  }

  private openInterval(interval: PresenceInterval): void {
    this.open.set(interval.slot, interval);
    this.emit({ type: 'open', interval });
  }

  private closeSlot(slot: number, ts: number): void {
    const cur = this.open.get(slot);
    if (!cur) return;
    this.open.delete(slot);
    // Toujours refermer, meme a duree nulle : l'intervalle est deja persiste.
    const to = Math.max(ts, cur.from);
    cur.to = to;
    this.emit({ type: 'close', interval: cur, to });
  }

  private closeAll(ts: number): void {
    for (const slot of [...this.open.keys()]) this.closeSlot(slot, ts);
  }
}
