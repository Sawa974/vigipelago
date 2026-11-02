import type { ApEvent } from '../db/db';

/** Un goal atteint pendant une coupure n'a pas d'instant : absent ici ne veut pas dire pas fini. */
export function goalInstants(events: readonly ApEvent[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of events) {
    if (e.kind !== 'goal' || e.srcSlot === null) continue;
    const prev = out.get(e.srcSlot);
    // Le plus tot : la cle de dedup d'un goal hache la minute, une annonce peut etre en double.
    if (prev === undefined || e.ts < prev) out.set(e.srcSlot, e.ts);
  }
  return out;
}
