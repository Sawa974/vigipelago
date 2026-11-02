import { describe, expect, it } from 'vitest';
import type { ApEvent, CaptureSession, LocationSnapshot } from '../db/db';
import {
  ARCHIVE_FORMAT,
  encodeEvent,
  encodeLine,
  encodeSession,
  encodeSnapshot,
  parseArchive,
  summarizeArchive,
  validateArchive,
  type ArchiveRecord,
  type HeaderRecord,
} from './ndjson';

const M = 60_000;

function header(over: Partial<HeaderRecord> = {}): HeaderRecord {
  return {
    t: 'header',
    format: ARCHIVE_FORMAT,
    mode: 'full',
    exportedAt: 100 * M,
    appVersion: '0.2.0',
    exportId: 'exp-1',
    rooms: ['Seed42'],
    ...over,
  };
}

function event(over: Partial<ApEvent> = {}): ApEvent {
  return {
    id: 1,
    roomId: 'Seed42',
    ts: 10 * M,
    tsPrecision: 'exact',
    tsLower: null,
    tsUpper: null,
    kind: 'item',
    team: 0,
    srcSlot: 3,
    dstSlot: 4,
    itemId: 77,
    locationId: 1204,
    itemFlags: 1,
    text: 'Truc envoye a Machin',
    segments: [{ text: 'Truc', cls: 'item' }],
    tags: null,
    sessionId: 7,
    raw: { cmd: 'PrintJSON' },
    dedupKey: 'i:0:3:1204',
    ...over,
  };
}

function session(over: Partial<CaptureSession> = {}): CaptureSession {
  return {
    id: 7,
    roomId: 'Seed42',
    connectedAsSlot: 'Ada',
    startedAt: 10 * M,
    endedAt: 20 * M,
    lastHeartbeatAt: 20 * M,
    closeReason: 'user',
    appVersion: '0.2.0',
    ...over,
  };
}

function lines(records: ArchiveRecord[]): string {
  return records.map(encodeLine).join('\n') + '\n';
}

describe('encodeEvent', () => {
  it('retire id et sessionId, remplaces par la reference de session d origine', () => {
    const rec = encodeEvent(event(), 7, 'full');
    expect(rec.srcSessionId).toBe(7);
    expect(rec.event).not.toHaveProperty('id');
    expect(rec.event).not.toHaveProperty('sessionId');
    expect(rec.event.dedupKey).toBe('i:0:3:1204');
  });

  it('met raw a null en mode allege, sans toucher au texte rendu', () => {
    const rec = encodeEvent(event(), 7, 'light');
    expect(rec.event.raw).toBeNull();
    expect(rec.event.text).toBe('Truc envoye a Machin');
    expect(rec.event.segments).toHaveLength(1);
  });

  it('conserve raw en mode complet', () => {
    expect(encodeEvent(event(), 7, 'full').event.raw).toEqual({ cmd: 'PrintJSON' });
  });
});

describe('encodeSession / encodeSnapshot', () => {
  it('expose l id d origine dans srcId, pour le remappage a l import', () => {
    const rec = encodeSession(session());
    expect(rec.srcId).toBe(7);
    expect(rec.session).not.toHaveProperty('id');
  });

  it('reporte le sessionId d un snapshot dans srcSessionId', () => {
    const snap: LocationSnapshot = {
      id: 2,
      roomId: 'Seed42',
      team: 0,
      slot: 3,
      ts: 12 * M,
      sessionId: 7,
      checkedLocations: [-1, 1204],
    };
    const rec = encodeSnapshot(snap);
    expect(rec.srcSessionId).toBe(7);
    expect(rec.snapshot).not.toHaveProperty('id');
    expect(rec.snapshot).not.toHaveProperty('sessionId');
    expect(rec.snapshot.checkedLocations).toEqual([-1, 1204]);
  });
});

describe('parseArchive', () => {
  it('fait un aller-retour fidele', () => {
    const text = lines([header(), { t: 'event', srcSessionId: 7, event: encodeEvent(event(), 7, 'full').event }]);
    const parsed = parseArchive(text);
    expect(parsed.header?.exportId).toBe('exp-1');
    expect(parsed.records).toHaveLength(1);
    expect(parsed.problems).toEqual([]);
  });

  it('ignore les lignes vides sans les signaler', () => {
    const parsed = parseArchive('\n' + encodeLine(header()) + '\n\n');
    expect(parsed.header).not.toBeNull();
    expect(parsed.problems).toEqual([]);
  });

  it('signale une ligne illisible et traite quand meme le reste', () => {
    const text = [encodeLine(header()), '{ pas du json', encodeLine({ t: 'slotStats', stats: { roomId: 'Seed42', slot: 3, totalLocations: 220, checkedFromServer: 34, hintPoints: null, hintCostObserved: null, hintCostObservedFor: null, updatedAt: 0 } })].join('\n');
    const parsed = parseArchive(text);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.problems).toEqual([{ line: 2, kind: 'error', key: 'ndjson.badJson' }]);
  });

  it('ignore un type inconnu en le signalant comme saute, pas comme une erreur', () => {
    const text = [encodeLine(header()), '{"t":"futur","x":1}'].join('\n');
    const parsed = parseArchive(text);
    expect(parsed.records).toHaveLength(0);
    expect(parsed.problems[0]).toMatchObject({ line: 2, kind: 'skipped' });
  });

  it('refuse un second en-tete', () => {
    const parsed = parseArchive(lines([header(), header()]));
    expect(parsed.problems[0]).toMatchObject({ kind: 'error', key: 'ndjson.dupHeader' });
  });

  it('supporte un fichier tronque en cours de ligne', () => {
    const full = lines([header(), encodeEvent(event(), 7, 'full')]);
    const truncated = full.slice(0, full.length - 20);
    const parsed = parseArchive(truncated);
    expect(parsed.header).not.toBeNull();
    expect(parsed.problems.some((p) => p.kind === 'error')).toBe(true);
  });
});

describe('validateArchive', () => {
  it('accepte une archive du format courant', () => {
    expect(validateArchive(parseArchive(lines([header()])))).toEqual([]);
  });

  it('refuse un fichier sans en-tete', () => {
    const reasons = validateArchive(parseArchive('{"t":"room","room":{}}'));
    expect(reasons[0].key).toBe('ndjson.noHeader');
  });

  it('refuse un format plus recent plutot que de fusionner a moitie', () => {
    const reasons = validateArchive(parseArchive(lines([header({ format: ARCHIVE_FORMAT + 1 })])));
    expect(reasons[0].key).toBe('ndjson.newer');
  });
});

describe('summarizeArchive', () => {
  const exact = encodeEvent(event(), 7, 'full');
  const approx = encodeEvent(
    event({
      ts: 15 * M,
      tsPrecision: 'approx',
      tsLower: 12 * M,
      tsUpper: 18 * M,
      kind: 'chat',
      dedupKey: 'x:chat:abc:15',
    }),
    7,
    'full',
  );

  it('compte les evenements par precision, par kind, et borne le journal', () => {
    const s = summarizeArchive(parseArchive(lines([header(), exact, approx])))!;
    expect(s.events).toBe(2);
    expect(s.eventsExact).toBe(1);
    expect(s.eventsApprox).toBe(1);
    expect(s.firstEventAt).toBe(10 * M);
    expect(s.lastEventAt).toBe(15 * M);
    expect(s.byKind).toEqual([
      { kind: 'item', count: 1 },
      { kind: 'chat', count: 1 },
    ]);
  });

  it('distingue un fichier allege : aucun raw', () => {
    const light = encodeEvent(event(), 7, 'light');
    const s = summarizeArchive(parseArchive(lines([header({ mode: 'light' }), light])))!;
    expect(s.eventsWithRaw).toBe(0);
    expect(s.header.mode).toBe('light');
  });

  it('mesure la couverture des sessions du fichier, trous exclus', () => {
    const a = encodeSession(session({ id: 7, startedAt: 10 * M, endedAt: 20 * M, lastHeartbeatAt: 20 * M }));
    const b = encodeSession(session({ id: 8, startedAt: 50 * M, endedAt: 60 * M, lastHeartbeatAt: 60 * M }));
    const s = summarizeArchive(parseArchive(lines([header(), a, b])))!;
    expect(s.sessions).toBe(2);
    expect(s.coveredMs).toBe(20 * M);
  });

  it('borne une session laissee ouverte a la date d export, pas a maintenant', () => {
    const open = encodeSession(
      session({ id: 9, startedAt: 90 * M, endedAt: null, lastHeartbeatAt: 95 * M }),
    );
    const s = summarizeArchive(parseArchive(lines([header({ exportedAt: 100 * M }), open])))!;
    expect(s.coveredMs).toBe(10 * M);
  });

  it('presente la partie par ses slots, ses jeux et sa date de creation', () => {
    const room: ArchiveRecord = {
      t: 'room',
      room: {
        roomId: 'Seed42',
        seedName: 'Seed42',
        label: 'Seed42',
        host: 'h',
        port: 1,
        players: [
          { team: 0, slot: 1, name: 'Ada', alias: 'Ada', game: 'Zelda' },
          { team: 0, slot: 2, name: 'Bob', alias: 'Bob', game: 'Zelda' },
          { team: 0, slot: 3, name: 'Eve', alias: 'Eve', game: 'Metroid' },
        ],
        firstSeenAt: 0,
        createdAt: 5 * M,
        lastSeenAt: 0,
        hintCost: null,
        locationCheckPoints: null,
      },
    };
    const r = summarizeArchive(parseArchive(lines([header(), room])))!.rooms[0];
    expect(r.createdAt).toBe(5 * M);
    expect(r.games).toBe(2);
    expect(r.slots.map((x) => x.name)).toEqual(['Ada', 'Bob', 'Eve']);
  });

  it('rend null sans en-tete', () => {
    expect(summarizeArchive(parseArchive(''))).toBeNull();
  });

  it('remonte les problemes de lecture avec le bilan', () => {
    const s = summarizeArchive(parseArchive([encodeLine(header()), 'xxx'].join('\n')))!;
    expect(s.problems).toHaveLength(1);
  });
});
