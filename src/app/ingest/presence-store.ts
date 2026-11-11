import Dexie from 'dexie';
import { db } from '../db/db';
import { replayPresence, type ReplaySession } from './rebuild-presence';

export interface PresenceRebuild {
  roomId: string;
  team: number;
  slots: readonly number[];
  sessions: readonly ReplaySession[];
  textClientSlots: ReadonlySet<number>;
}

/** Remplace toute la presence stockee de la room ; rend le nombre d'intervalles ecrits. */
export async function rebuildPresenceRows(p: PresenceRebuild): Promise<number> {
  const events = await db.events
    .where('[roomId+ts]')
    .between([p.roomId, Dexie.minKey], [p.roomId, Dexie.maxKey])
    .toArray();

  const intervals = replayPresence({
    ...p,
    events: events.map((e) => ({ ts: e.ts, kind: e.kind, srcSlot: e.srcSlot, tags: e.tags })),
  });

  await db.transaction('rw', db.presence, async () => {
    await db.presence
      .where('[roomId+slot+from]')
      .between([p.roomId, Dexie.minKey, Dexie.minKey], [p.roomId, Dexie.maxKey, Dexie.maxKey])
      .delete();
    await db.presence.bulkAdd(intervals);
  });
  return intervals.length;
}
