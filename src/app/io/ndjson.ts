import { wellFormed } from './archive-guards';
import type {
  ApEvent,
  CachedGamePackage,
  CaptureSession,
  LocationSnapshot,
  Room,
  SlotStats,
} from '../db/db';
import { mergeCoverage } from '../ingest/coverage';
import type { Key } from '../i18n/en';
import type { Params } from '../i18n/translate';

/** A incrementer si un enregistrement change de forme. */
export const ARCHIVE_FORMAT = 1;

/** `light` omet `raw` et le cache DataPackage. */
export type ArchiveMode = 'full' | 'light';

export interface HeaderRecord {
  t: 'header';
  format: number;
  mode: ArchiveMode;
  exportedAt: number;
  appVersion: string;
  exportId: string;
  rooms: string[];
}

export interface RoomRecord {
  t: 'room';
  room: Room;
}

/** `srcId` est l'id de la base d'origine, a remapper a l'import. */
export interface SessionRecord {
  t: 'session';
  srcId: number;
  session: Omit<CaptureSession, 'id'>;
}

export interface EventRecord {
  t: 'event';
  srcSessionId: number;
  event: Omit<ApEvent, 'id' | 'sessionId'>;
}

export interface SnapshotRecord {
  t: 'snapshot';
  srcSessionId: number;
  snapshot: Omit<LocationSnapshot, 'id' | 'sessionId'>;
}

export interface SlotStatsRecord {
  t: 'slotStats';
  stats: SlotStats;
}

export interface DataPackageRecord {
  t: 'dataPackage';
  pkg: CachedGamePackage;
}

export type ArchiveRecord =
  | HeaderRecord
  | RoomRecord
  | SessionRecord
  | EventRecord
  | SnapshotRecord
  | SlotStatsRecord
  | DataPackageRecord;

const KNOWN_TYPES = new Set(['header', 'room', 'session', 'event', 'snapshot', 'slotStats', 'dataPackage']);

export function encodeLine(record: ArchiveRecord): string {
  return JSON.stringify(record);
}

/** En `light`, `raw` vaut `null` et n'est pas supprime. */
export function encodeEvent(event: ApEvent, srcSessionId: number, mode: ArchiveMode): EventRecord {
  const { id: _id, sessionId: _sessionId, ...rest } = event;
  return {
    t: 'event',
    srcSessionId,
    event: mode === 'light' ? { ...rest, raw: null } : rest,
  };
}

export function encodeSession(session: CaptureSession): SessionRecord {
  const { id, ...rest } = session;
  return { t: 'session', srcId: id!, session: rest };
}

export function encodeSnapshot(snapshot: LocationSnapshot): SnapshotRecord {
  const { id: _id, sessionId, ...rest } = snapshot;
  return { t: 'snapshot', srcSessionId: sessionId, snapshot: rest };
}

export interface Notice {
  key: Key;
  params?: Params;
}

export interface LineProblem {
  /** A partir de 1. */
  line: number;
  key: Key;
  params?: Params;
  kind: 'error' | 'skipped';
}

export interface ParsedArchive {
  header: HeaderRecord | null;
  records: ArchiveRecord[];
  problems: LineProblem[];
}

export function parseArchive(text: string): ParsedArchive {
  const out: ParsedArchive = { header: null, records: [], problems: [] };
  const lines = text.split('\n');

  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line === '') return;
    const lineNo = i + 1;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      out.problems.push({ line: lineNo, kind: 'error', key: 'ndjson.badJson' });
      return;
    }

    if (typeof value !== 'object' || value === null || !('t' in value)) {
      out.problems.push({ line: lineNo, kind: 'error', key: 'ndjson.noT' });
      return;
    }

    const record = value as ArchiveRecord;
    if (!KNOWN_TYPES.has(record.t)) {
      out.problems.push({
        line: lineNo,
        kind: 'skipped',
        key: 'ndjson.unknownType',
        params: { type: String(record.t) },
      });
      return;
    }

    if (!wellFormed(record)) {
      out.problems.push({ line: lineNo, kind: 'error', key: 'ndjson.badShape', params: { type: record.t } });
      return;
    }

    if (record.t === 'header') {
      if (out.header !== null) {
        out.problems.push({ line: lineNo, kind: 'error', key: 'ndjson.dupHeader' });
        return;
      }
      out.header = record;
      return;
    }

    out.records.push(record);
  });

  return out;
}

export function validateArchive(parsed: ParsedArchive): Notice[] {
  const reasons: Notice[] = [];
  if (parsed.header === null) {
    reasons.push({ key: 'ndjson.noHeader' });
    return reasons;
  }
  if (typeof parsed.header.format !== 'number') {
    reasons.push({ key: 'ndjson.noFormat' });
  } else if (parsed.header.format > ARCHIVE_FORMAT) {
    reasons.push({ key: 'ndjson.newer', params: { format: parsed.header.format, max: ARCHIVE_FORMAT } });
  }
  return reasons;
}

export interface ArchiveSummary {
  header: HeaderRecord;
  rooms: {
    roomId: string;
    label: string;
    players: number;
    createdAt: number | null;
    slots: { slot: number; name: string; game: string }[];
    games: number;
  }[];
  sessions: number;
  /** Trous exclus. */
  coveredMs: number;
  events: number;
  eventsExact: number;
  eventsApprox: number;
  eventsWithRaw: number;
  byKind: { kind: string; count: number }[];
  firstEventAt: number | null;
  lastEventAt: number | null;
  snapshots: number;
  slotStats: number;
  dataPackages: number;
  problems: LineProblem[];
}

export function summarizeArchive(parsed: ParsedArchive): ArchiveSummary | null {
  if (parsed.header === null) return null;

  const rooms: ArchiveSummary['rooms'] = [];
  const sessions: { startedAt: number; endedAt: number | null; lastHeartbeatAt: number }[] = [];
  const kinds = new Map<string, number>();
  let events = 0;
  let eventsExact = 0;
  let eventsApprox = 0;
  let eventsWithRaw = 0;
  let firstEventAt: number | null = null;
  let lastEventAt: number | null = null;
  let snapshots = 0;
  let slotStats = 0;
  let dataPackages = 0;

  for (const r of parsed.records) {
    switch (r.t) {
      case 'room':
        rooms.push({
          roomId: r.room.roomId,
          label: r.room.label,
          players: r.room.players?.length ?? 0,
          createdAt: r.room.createdAt ?? null,
          slots: (r.room.players ?? []).map((p) => ({ slot: p.slot, name: p.name, game: p.game })),
          games: new Set((r.room.players ?? []).map((p) => p.game).filter(Boolean)).size,
        });
        break;
      case 'session':
        sessions.push(r.session);
        break;
      case 'event': {
        events++;
        const e = r.event;
        if (e.tsPrecision === 'approx') eventsApprox++;
        else eventsExact++;
        if (e.raw !== null && e.raw !== undefined) eventsWithRaw++;
        kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
        if (firstEventAt === null || e.ts < firstEventAt) firstEventAt = e.ts;
        if (lastEventAt === null || e.ts > lastEventAt) lastEventAt = e.ts;
        break;
      }
      case 'snapshot':
        snapshots++;
        break;
      case 'slotStats':
        slotStats++;
        break;
      case 'dataPackage':
        dataPackages++;
        break;
    }
  }

  // Une session restee ouverte s'arrete a la date d'export.
  const coveredMs = mergeCoverage(sessions, parsed.header.exportedAt).reduce(
    (sum, i) => sum + (i.to - i.from),
    0,
  );

  return {
    header: parsed.header,
    rooms,
    sessions: sessions.length,
    coveredMs,
    events,
    eventsExact,
    eventsApprox,
    eventsWithRaw,
    byKind: [...kinds].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    firstEventAt,
    lastEventAt,
    snapshots,
    slotStats,
    dataPackages,
    problems: parsed.problems,
  };
}
