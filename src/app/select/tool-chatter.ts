import { classifyTags } from '../protocol/tags';

export interface ChatterEvent {
  kind: string;
  srcSlot: number | null;
  tags: string[] | null;
  sessionId: number;
  dedupKey: string;
}

/** Evenements en ordre chronologique : un Part sans tags s'apparie au Join qui le precede. */
export function toolChatterKeys(events: readonly ChatterEvent[]): Set<string> {
  const keys = new Set<string>();
  // Par session : sinon un Part non vu avalerait le depart d'un vrai joueur plus tard.
  const pending = new Map<string, number>();

  for (const e of events) {
    if (e.srcSlot === null) continue;
    const at = `${e.sessionId}:${e.srcSlot}`;

    if (e.kind === 'join') {
      if (classifyTags(e.tags) !== 'self') continue;
      pending.set(at, (pending.get(at) ?? 0) + 1);
      keys.add(e.dedupKey);
    } else if (e.kind === 'part') {
      const owed = pending.get(at) ?? 0;
      if (owed <= 0) continue;
      pending.set(at, owed - 1);
      keys.add(e.dedupKey);
    }
  }

  return keys;
}
