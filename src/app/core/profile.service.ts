import { Injectable, signal } from '@angular/core';
import { db, type ConnectionProfile } from '../db/db';
import {
  attachPlan,
  dedupeByRoom,
  deriveProfiles,
  missingProfiles,
  repairRoomLinks,
  profileFromLegacyTarget,
  shortRoomId,
  sortProfiles,
  targetKey,
} from './profiles';

/** Ancien stockage a une seule cible, lu seulement pour migrer. */
const LEGACY_TARGET_KEY = 'vigipelago.target';

const SEEDED_KEY = 'profilesSeeded';

export interface DeletionPreview {
  events: number;
  sessions: number;
  snapshots: number;
}

export class DuplicateTargetError extends Error {
  constructor() {
    super('duplicate target');
    this.name = 'DuplicateTargetError';
  }
}

@Injectable({ providedIn: 'root' })
export class ProfileService {
  readonly profiles = signal<ConnectionProfile[]>([]);
  readonly knownRoomIds = signal<string[]>([]);

  /** L'ancienne cible n'est amorcee qu'une fois : la reproposer ignorerait une suppression. */
  async load(): Promise<void> {
    const seeded = await db.settings.get(SEEDED_KEY);
    // En premier : un lien de room faux ferait re-deriver la mauvaise ligne.
    await this.repairLinks();
    await this.seedFromHistory(!seeded?.value);
    await this.dedupe();
    await this.refresh();
  }

  private async repairLinks(): Promise<void> {
    const [profiles, rooms, sessions] = await Promise.all([
      db.profiles.toArray(),
      db.rooms.toArray(),
      db.sessions.toArray(),
    ]);
    const fixes = repairRoomLinks(profiles, rooms, sessions);
    for (const f of fixes) {
      await db.profiles.update(f.id, {
        roomId: f.roomId,
        ...(f.label === undefined ? {} : { label: f.label }),
      });
    }
  }

  private async seedFromHistory(includeLegacy: boolean): Promise<void> {
    const now = Date.now();
    const [rooms, sessions, existing] = await Promise.all([
      db.rooms.toArray(),
      db.sessions.toArray(),
      db.profiles.toArray(),
    ]);
    const derived = missingProfiles(deriveProfiles(rooms, sessions, now), existing);

    const legacy = includeLegacy
      ? profileFromLegacyTarget(localStorage.getItem(LEGACY_TARGET_KEY), now)
      : null;
    const knownTargets = new Set([...existing, ...derived].map((p) => p.targetKey));
    if (legacy && !knownTargets.has(legacy.targetKey)) derived.push(legacy);

    if (derived.length) await db.profiles.bulkAdd(derived);
    await db.settings.put({ key: SEEDED_KEY, value: true });
  }

  /** Ne touche jamais aux donnees de la room, contrairement a `remove`. */
  private async dedupe(): Promise<void> {
    const rows = await db.profiles.toArray();
    const { keep, remove } = dedupeByRoom(rows);
    if (!remove.length) return;

    await db.transaction('rw', [db.profiles], async () => {
      await db.profiles.bulkDelete(remove.map((p) => p.id!).filter((id) => id !== undefined));
      for (const w of keep) {
        const before = rows.find((r) => r.id === w.id);
        if (before && before.label !== w.label) await db.profiles.update(w.id!, { label: w.label });
      }
    });
  }

  async refresh(): Promise<void> {
    const [rows, rooms] = await Promise.all([db.profiles.toArray(), db.rooms.toArray()]);
    this.profiles.set(sortProfiles(rows));
    this.knownRoomIds.set(rooms.map((r) => r.roomId));
  }

  /** Le slot des lignes rendues vient de l'exporteur : a faire confirmer avant connexion. */
  async reloadAfterImport(): Promise<ConnectionProfile[]> {
    const before = new Set(this.profiles().map((p) => p.id));
    await this.load();
    return this.profiles().filter((p) => !before.has(p.id));
  }

  short(roomId: string): string {
    return shortRoomId(roomId, this.knownRoomIds());
  }

  async remember(input: {
    host: string;
    port: number;
    slotName: string;
    label?: string;
  }): Promise<number> {
    const key = targetKey(input.host, input.port, input.slotName);
    // `targetKey` n'est pas unique : plusieurs parties possibles, la plus recente.
    const existing = sortProfiles(await db.profiles.where('targetKey').equals(key).toArray())[0];
    const label = input.label?.trim() ?? '';

    if (existing) {
      await db.profiles.update(existing.id!, {
        host: input.host.trim(),
        port: Number(input.port),
        slotName: input.slotName.trim(),
        ...(label ? { label } : {}),
        lastUsedAt: Date.now(),
      });
      await this.refresh();
      return existing.id!;
    }

    const id = await db.profiles.add({
      label,
      host: input.host.trim(),
      port: Number(input.port),
      slotName: input.slotName.trim(),
      targetKey: key,
      roomId: null,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    await this.refresh();
    return id as number;
  }

  /** L'id rendu n'est pas forcement `profileId` : une ligne neuve peut naitre. */
  async attachRoom(profileId: number, roomId: string): Promise<number> {
    const current = await db.profiles.get(profileId);
    if (!current) return profileId;
    const plan = attachPlan(current, roomId);
    // Seul endroit ou `lastUsedAt` avance pour une ligne deja rattachee.
    if (plan === 'none') {
      await db.profiles.update(profileId, { lastUsedAt: Date.now() });
      await this.refresh();
      return profileId;
    }

    if (plan === 'link') {
      await db.profiles.update(profileId, { roomId, lastUsedAt: Date.now() });
    } else {
      const { id: _old, ...copy } = current;
      await db.profiles.add({ ...copy, label: '', roomId, createdAt: Date.now(), lastUsedAt: Date.now() });
    }
    await this.dedupe();
    await this.refresh();
    return this.profiles().find((p) => p.roomId === roomId)?.id ?? profileId;
  }

  async edit(
    id: number,
    changes: { label?: string; host?: string; port?: number; slotName?: string },
  ): Promise<void> {
    const current = await db.profiles.get(id);
    if (!current) return;
    const host = changes.host?.trim() ?? current.host;
    const port = changes.port === undefined ? current.port : Number(changes.port);
    const slotName = changes.slotName?.trim() ?? current.slotName;
    const key = targetKey(host, port, slotName);

    if (key !== current.targetKey) {
      const same = await db.profiles.where('targetKey').equals(key).toArray();
      if (same.some((o) => o.id !== id && o.roomId === current.roomId)) {
        throw new DuplicateTargetError();
      }
    }

    await db.profiles.update(id, {
      ...(changes.label === undefined ? {} : { label: changes.label.trim() }),
      host,
      port,
      slotName,
      targetKey: key,
    });
    await this.refresh();
  }

  async previewDeletion(profile: ConnectionProfile): Promise<DeletionPreview> {
    if (!profile.roomId) return { events: 0, sessions: 0, snapshots: 0 };
    const roomId = profile.roomId;
    const [events, sessions, snapshots] = await Promise.all([
      db.events.where('[roomId+ts]').between([roomId, -Infinity], [roomId, Infinity]).count(),
      db.sessions.where('roomId').equals(roomId).count(),
      db.snapshots
        .where('[roomId+slot+ts]')
        .between([roomId, -Infinity, -Infinity], [roomId, Infinity, Infinity])
        .count(),
    ]);
    return { events, sessions, snapshots };
  }

  /** Efface aussi toutes les donnees de la room, irreversiblement. */
  async remove(profile: ConnectionProfile): Promise<void> {
    const roomId = profile.roomId;
    await db.transaction(
      'rw',
      [db.profiles, db.events, db.sessions, db.rooms, db.snapshots, db.presence, db.slotStats, db.settings],
      async () => {
        if (profile.id !== undefined) await db.profiles.delete(profile.id);
        if (!roomId) return;

        await db.events.where('[roomId+ts]').between([roomId, -Infinity], [roomId, Infinity]).delete();
        await db.sessions.where('roomId').equals(roomId).delete();
        await db.snapshots
          .where('[roomId+slot+ts]')
          .between([roomId, -Infinity, -Infinity], [roomId, Infinity, Infinity])
          .delete();
        await db.presence
          .where('[roomId+slot+from]')
          .between([roomId, -Infinity, -Infinity], [roomId, Infinity, Infinity])
          .delete();
        await db.slotStats.where('roomId').equals(roomId).delete();
        await db.rooms.delete(roomId);
        await db.settings.bulkDelete([`lastSweepAt:${roomId}`, `textClientSlots:${roomId}`]);
      },
    );
    await this.refresh();
  }
}
