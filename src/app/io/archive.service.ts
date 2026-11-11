import { Injectable } from '@angular/core';
import {
  db,
  type ApEvent,
  type CachedGamePackage,
  type CaptureSession,
  type LocationSnapshot,
  type Room,
  type SlotStats,
} from '../db/db';
import { APP_VERSION, TEXT_CLIENT_KEY } from '../core/ap-session.service';
import { mergeCoverage } from '../ingest/coverage';
import { rebuildPresenceRows } from '../ingest/presence-store';
import {
  archiveRoomIds,
  estimateClockOffset,
  planMerge,
  sessionIdentity,
  snapshotIdentity,
  type ClockOffset,
  type LocalEventRef,
  type MergeCounts,
} from './merge';
import {
  ARCHIVE_FORMAT,
  encodeEvent,
  encodeLine,
  encodeSession,
  encodeSnapshot,
  parseArchive,
  summarizeArchive,
  validateArchive,
  type ArchiveMode,
  type ArchiveSummary,
  type HeaderRecord,
  type LineProblem,
  type Notice,
} from './ndjson';

export interface ExportResult {
  blob: Blob;
  filename: string;
  /** En-tete compris. */
  lines: number;
}

export interface ImportReport {
  roomIds: string[];
  offset: ClockOffset;
  counts: MergeCounts;
  sessionsAdded: number;
  sessionsKnown: number;
  snapshotsAdded: number;
  statsWritten: number;
  packagesAdded: number;
  presenceRebuilt: number;
  coverageGainedMs: number;
  problems: LineProblem[];
}

export interface InspectResult {
  summary: ArchiveSummary | null;
  reasons: Notice[];
}

@Injectable({ providedIn: 'root' })
export class ArchiveService {
  /** `settings` n'est jamais exporte : `textClientSlots` ecraserait la declaration du receveur. */
  async exportArchive(roomId: string, mode: ArchiveMode): Promise<ExportResult> {
    const rooms = await db.rooms.where({ roomId }).toArray();
    const keep = (id: string) => id === roomId;

    const sessions = (await db.sessions.toArray()).filter((s) => keep(s.roomId));
    const events = (await db.events.toArray()).filter((e) => keep(e.roomId));
    const snapshots = (await db.snapshots.toArray()).filter((s) => keep(s.roomId));
    const slotStats = (await db.slotStats.toArray()).filter((s) => keep(s.roomId));
    const packages = mode === 'full' ? await db.dataPackages.toArray() : [];

    const header: HeaderRecord = {
      t: 'header',
      format: ARCHIVE_FORMAT,
      mode,
      exportedAt: Date.now(),
      appVersion: APP_VERSION,
      exportId: newExportId(),
      rooms: rooms.map((r) => r.roomId),
    };

    const lines: string[] = [encodeLine(header)];
    for (const room of rooms) lines.push(encodeLine({ t: 'room', room }));
    for (const session of sessions) lines.push(encodeLine(encodeSession(session)));
    for (const event of events) lines.push(encodeLine(encodeEvent(event, event.sessionId, mode)));
    for (const snapshot of snapshots) lines.push(encodeLine(encodeSnapshot(snapshot)));
    for (const stats of slotStats) lines.push(encodeLine({ t: 'slotStats', stats }));
    for (const pkg of packages) lines.push(encodeLine({ t: 'dataPackage', pkg }));

    const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/x-ndjson' });
    return { blob, filename: buildFilename(roomId, mode, header.exportedAt), lines: lines.length };
  }

  inspect(text: string): InspectResult {
    const parsed = parseArchive(text);
    return { summary: summarizeArchive(parsed), reasons: validateArchive(parsed) };
  }

  /** Tout ou rien, en une seule transaction. */
  async importArchive(text: string): Promise<ImportReport> {
    const parsed = parseArchive(text);
    const reasons = validateArchive(parsed);
    if (reasons.length) throw new Error(reasons.map((r) => r.key).join(' ; '));
    const header = parsed.header!;

    const rooms: Room[] = [];
    const sessions: { srcId: number; session: Omit<CaptureSession, 'id'> }[] = [];
    const events: { event: Omit<ApEvent, 'id' | 'sessionId'>; srcSessionId: number }[] = [];
    const snapshots: { srcSessionId: number; snapshot: Omit<LocationSnapshot, 'id' | 'sessionId'> }[] = [];
    const stats: SlotStats[] = [];
    const packages: CachedGamePackage[] = [];

    for (const r of parsed.records) {
      switch (r.t) {
        case 'room':
          rooms.push(r.room);
          break;
        case 'session':
          sessions.push({ srcId: r.srcId, session: r.session });
          break;
        case 'event':
          events.push({ event: r.event, srcSessionId: r.srcSessionId });
          break;
        case 'snapshot':
          snapshots.push({ srcSessionId: r.srcSessionId, snapshot: r.snapshot });
          break;
        case 'slotStats':
          stats.push(r.stats);
          break;
        case 'dataPackage':
          packages.push(r.pkg);
          break;
      }
    }

    const roomIds = archiveRoomIds(
      rooms,
      events.map((e) => e.event),
      snapshots.map((s) => s.snapshot),
      stats,
    );

    const localSessionsBefore = await db.sessions.toArray();
    const localEventRows = await db.events.filter((e) => roomIds.includes(e.roomId)).toArray();
    const localEvents: LocalEventRef[] = localEventRows.map((e) => ({
      id: e.id!,
      dedupKey: e.dedupKey,
      ts: e.ts,
      tsPrecision: e.tsPrecision,
      tsLower: e.tsLower,
      tsUpper: e.tsUpper,
      itemId: e.itemId,
      itemFlags: e.itemFlags,
    }));

    const localByKey = new Map(localEvents.map((e) => [e.dedupKey, e]));
    const offset = estimateClockOffset(
      localByKey,
      events.map((e) => e.event),
    );
    const plan = planMerge({ local: localEvents, incoming: events, offset });
    const coverageBefore = coveredMs(localSessionsBefore, roomIds);

    let sessionsAdded = 0;
    let sessionsKnown = 0;
    let snapshotsAdded = 0;
    let statsWritten = 0;
    let packagesAdded = 0;

    await db.transaction(
      'rw',
      [db.rooms, db.sessions, db.events, db.snapshots, db.slotStats, db.dataPackages],
      async () => {
        for (const room of rooms) {
          const existing = await db.rooms.get(room.roomId);
          await db.rooms.put(existing ? mergeRoom(existing, room) : room);
        }

        // Ids remappes ; l'identite par contenu evite de gonfler la couverture au reimport.
        const byIdentity = new Map(localSessionsBefore.map((s) => [sessionIdentity(s), s.id!]));
        const sessionMap = new Map<number, number>();
        for (const { srcId, session } of sessions) {
          const identity = sessionIdentity(session);
          const known = byIdentity.get(identity);
          if (known !== undefined) {
            sessionMap.set(srcId, known);
            sessionsKnown++;
            continue;
          }
          const newId = (await db.sessions.add({
            ...session,
            importedFrom: header.exportId,
          })) as number;
          byIdentity.set(identity, newId);
          sessionMap.set(srcId, newId);
          sessionsAdded++;
        }

        // Session de repli bornee a l'export, pour ne revendiquer aucune couverture.
        let fallbackId: number | null = null;
        const resolveSession = async (srcId: number): Promise<number> => {
          const mapped = sessionMap.get(srcId);
          if (mapped !== undefined) return mapped;
          if (fallbackId === null) {
            fallbackId = (await db.sessions.add({
              roomId: roomIds[0] ?? 'inconnu',
              connectedAsSlot: 'import',
              startedAt: header.exportedAt,
              endedAt: header.exportedAt,
              lastHeartbeatAt: header.exportedAt,
              closeReason: 'user',
              appVersion: header.appVersion,
              importedFrom: header.exportId,
            })) as number;
            sessionsAdded++;
          }
          return fallbackId;
        };

        for (const create of plan.creates) {
          await db.events.add({
            ...create.event,
            sessionId: await resolveSession(create.srcSessionId),
          } as ApEvent);
        }
        for (const update of plan.updates) {
          await db.events.update(update.id, update.changes);
        }

        const knownSnapshots = new Set(
          (await db.snapshots.filter((s) => roomIds.includes(s.roomId)).toArray()).map(snapshotIdentity),
        );
        for (const { srcSessionId, snapshot } of snapshots) {
          const identity = snapshotIdentity(snapshot);
          if (knownSnapshots.has(identity)) continue;
          knownSnapshots.add(identity);
          await db.snapshots.add({
            ...snapshot,
            sessionId: await resolveSession(srcSessionId),
          } as LocationSnapshot);
          snapshotsAdded++;
        }

        for (const row of stats) {
          const existing = await db.slotStats.get([row.roomId, row.slot]);
          if (!existing || row.updatedAt > existing.updatedAt) {
            // Un absent ne remplace jamais un connu : un `put` tel quel effacerait le solde.
            await db.slotStats.put({
              ...row,
              hintPoints: row.hintPoints ?? existing?.hintPoints ?? null,
              hintCostObserved: row.hintCostObserved ?? existing?.hintCostObserved ?? null,
              hintCostObservedFor:
                row.hintCostObservedFor ?? existing?.hintCostObservedFor ?? null,
            });
            statsWritten++;
          }
        }

        for (const pkg of packages) {
          if (await db.dataPackages.get(pkg.game)) continue;
          await db.dataPackages.put(pkg);
          packagesAdded++;
        }
      },
    );

    // Hors transaction : un rejeu rate n'annule pas un import valide.
    let presenceRebuilt = 0;
    for (const roomId of roomIds) presenceRebuilt += await this.rebuildPresence(roomId);

    const coverageAfter = coveredMs(await db.sessions.toArray(), roomIds);

    return {
      roomIds,
      offset,
      counts: plan.counts,
      sessionsAdded,
      sessionsKnown,
      snapshotsAdded,
      statsWritten,
      packagesAdded,
      presenceRebuilt,
      coverageGainedMs: Math.max(0, coverageAfter - coverageBefore),
      problems: parsed.problems,
    };
  }

  /** Slots lus dans `rooms`, pas dans `Connected` : la room peut n'avoir jamais ete connectee. */
  private async rebuildPresence(roomId: string): Promise<number> {
    const room = await db.rooms.get(roomId);
    if (!room?.players?.length) return 0;

    const sessions = await db.sessions.where('roomId').equals(roomId).toArray();
    if (!sessions.length) return 0;

    const declared = await db.settings.get(TEXT_CLIENT_KEY(roomId));
    return rebuildPresenceRows({
      roomId,
      team: room.players[0].team ?? 0,
      slots: room.players.map((p) => p.slot),
      sessions,
      textClientSlots: new Set((declared?.value as number[] | undefined) ?? []),
    });
  }
}

function mergeRoom(local: Room, incoming: Room): Room {
  const [newer, older] = incoming.lastSeenAt > local.lastSeenAt ? [incoming, local] : [local, incoming];
  const players = [...local.players];
  for (const p of incoming.players ?? []) {
    if (!players.some((q) => q.team === p.team && q.slot === p.slot)) players.push(p);
  }
  return {
    ...local,
    label: local.label || incoming.label,
    players,
    firstSeenAt: Math.min(local.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: Math.max(local.lastSeenAt, incoming.lastSeenAt),
    createdAt:
      local.createdAt === null
        ? incoming.createdAt
        : incoming.createdAt === null
          ? local.createdAt
          : Math.min(local.createdAt, incoming.createdAt),
    serverVersion: newer.serverVersion ?? older.serverVersion ?? null,
    generatorVersion: newer.generatorVersion ?? older.generatorVersion ?? null,
    permissions: newer.permissions ?? older.permissions ?? null,
    password: newer.password ?? older.password ?? null,
    raceMode: newer.raceMode ?? older.raceMode ?? null,
  };
}

function coveredMs(sessions: CaptureSession[], roomIds: string[]): number {
  const scoped = sessions.filter((s) => roomIds.includes(s.roomId));
  return mergeCoverage(scoped, Date.now()).reduce((sum, i) => sum + (i.to - i.from), 0);
}

function newExportId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function buildFilename(roomId: string, mode: ArchiveMode, at: number): string {
  const d = new Date(at);
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
    `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const room = slug(roomId);
  const suffix = mode === 'light' ? '-allege' : '';
  return `vigipelago-${room}-${stamp}${suffix}.ndjson`;
}

function slug(input: string): string {
  return (
    input
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'room'
  );
}
