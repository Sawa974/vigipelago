import type { ArchiveRecord } from './ndjson';

// Seuls les champs que l'import indexe ou calcule : un manque y fait une ligne invisible ou un NaN.

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): boolean => v === null || num(v);
const str = (v: unknown): boolean => typeof v === 'string';

function event(e: unknown): boolean {
  return (
    isObj(e) &&
    str(e['roomId']) &&
    str(e['dedupKey']) &&
    str(e['kind']) &&
    str(e['text']) &&
    num(e['ts']) &&
    num(e['team']) &&
    (e['tsPrecision'] === 'exact' || e['tsPrecision'] === 'approx') &&
    numOrNull(e['tsLower']) &&
    numOrNull(e['tsUpper']) &&
    numOrNull(e['srcSlot']) &&
    numOrNull(e['dstSlot']) &&
    numOrNull(e['itemId']) &&
    numOrNull(e['locationId']) &&
    numOrNull(e['itemFlags']) &&
    Array.isArray(e['segments'])
  );
}

function session(s: unknown): boolean {
  return (
    isObj(s) &&
    str(s['roomId']) &&
    num(s['startedAt']) &&
    num(s['lastHeartbeatAt']) &&
    numOrNull(s['endedAt'])
  );
}

function room(r: unknown): boolean {
  return (
    isObj(r) &&
    str(r['roomId']) &&
    Array.isArray(r['players']) &&
    num(r['firstSeenAt']) &&
    num(r['lastSeenAt'])
  );
}

export function wellFormed(record: ArchiveRecord): boolean {
  const r = record as unknown as Obj;
  switch (record.t) {
    case 'header':
      // `format` reste a `validateArchive`, qui sait dire « plus recent » ou « absent ».
      return num(r['exportedAt']) && Array.isArray(r['rooms']);
    case 'room':
      return room(r['room']);
    case 'session':
      return num(r['srcId']) && session(r['session']);
    case 'event':
      return num(r['srcSessionId']) && event(r['event']);
    case 'snapshot': {
      const s = r['snapshot'];
      return (
        num(r['srcSessionId']) &&
        isObj(s) &&
        str(s['roomId']) &&
        num(s['slot']) &&
        num(s['team']) &&
        num(s['ts']) &&
        Array.isArray(s['checkedLocations']) &&
        s['checkedLocations'].every(num)
      );
    }
    case 'slotStats': {
      const s = r['stats'];
      return isObj(s) && str(s['roomId']) && num(s['slot']) && num(s['totalLocations']) && num(s['updatedAt']);
    }
    case 'dataPackage': {
      const p = r['pkg'];
      return isObj(p) && str(p['game']) && str(p['checksum']) && isObj(p['itemIdToName']) && isObj(p['locationIdToName']);
    }
  }
}
