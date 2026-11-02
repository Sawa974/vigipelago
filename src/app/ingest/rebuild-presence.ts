import type { PresenceInterval } from '../db/db';
import { PresenceTracker, type PresenceOp } from './presence';

// Rejeu session par session : entre deux, l'outil n'ecoutait pas, tout repart en `unknown`.

export const ACTIVITY_KINDS = new Set(['item', 'chat', 'goal', 'release', 'collect', 'hint']);

export interface ReplayEvent {
  ts: number;
  kind: string;
  srcSlot: number | null;
  /** Absents sur un Part : le protocole ne les y met pas. */
  tags: string[] | null;
}

export interface ReplaySession {
  startedAt: number;
  endedAt: number | null;
  lastHeartbeatAt: number;
}

export interface ReplayParams {
  roomId: string;
  team: number;
  slots: readonly number[];
  events: readonly ReplayEvent[];
  sessions: readonly ReplaySession[];
  textClientSlots?: ReadonlySet<number>;
}

export function replayPresence(p: ReplayParams): PresenceInterval[] {
  const out: PresenceInterval[] = [];
  const tracker = new PresenceTracker((op: PresenceOp) => {
    if (op.type === 'close') out.push({ ...op.interval });
  });
  if (p.textClientSlots) tracker.setTextClientSlots(p.textClientSlots, 0);

  const sessions = [...p.sessions].sort((a, b) => a.startedAt - b.startedAt);
  const events = [...p.events].sort((a, b) => a.ts - b.ts);
  let cursor = 0;

  for (const s of sessions) {
    const end = s.endedAt ?? Math.max(s.lastHeartbeatAt, s.startedAt);
    if (end <= s.startedAt) continue;

    tracker.begin(p.roomId, p.team, p.slots, s.startedAt);

    while (cursor < events.length && events[cursor].ts < s.startedAt) cursor++;
    for (let i = cursor; i < events.length && events[i].ts <= end; i++) {
      const e = events[i];
      if (e.srcSlot === null) continue;
      if (e.kind === 'join') tracker.join(e.srcSlot, e.tags, e.ts);
      else if (e.kind === 'part') tracker.part(e.srcSlot, e.ts);
      else if (ACTIVITY_KINDS.has(e.kind)) tracker.activity(e.srcSlot, e.ts);
    }

    tracker.end(end);
  }

  return out.filter((i) => (i.to ?? 0) > i.from);
}
