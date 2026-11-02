import type { CaptureSession, Room } from '../db/db';

/** Le mot de passe n'y figure pas, et ne doit jamais y figurer. */
export interface ConnectionProfile {
  id?: number;
  label: string;
  host: string;
  port: number;
  slotName: string;
  /** Pas unique : un serveur relance sert une autre partie. `roomId` fait l'unicite. */
  targetKey: string;
  roomId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export const SHORT_ID_LEN = 7;

/** Le slot est sensible a la casse : Archipelago distingue `Ada` de `ada`. */
export function targetKey(host: string, port: number, slotName: string): string {
  return `${host.trim().toLowerCase()}:${Number(port)}/${slotName.trim()}`;
}

export function shortRoomId(roomId: string, others: readonly string[] = []): string {
  const rivals = others.filter((o) => o !== roomId);
  for (let n = SHORT_ID_LEN; n < roomId.length; n++) {
    const p = roomId.slice(0, n);
    if (!rivals.some((o) => o.startsWith(p))) return p;
  }
  return roomId;
}

export function defaultLabel(
  profile: Pick<ConnectionProfile, 'roomId' | 'host'>,
  knownRoomIds: readonly string[] = [],
): string {
  return profile.roomId ? shortRoomId(profile.roomId, knownRoomIds) : profile.host;
}

export function labelOf(
  profile: ConnectionProfile,
  knownRoomIds: readonly string[] = [],
): string {
  const l = profile.label.trim();
  return l || defaultLabel(profile, knownRoomIds);
}

export function deriveProfiles(
  rooms: readonly Room[],
  sessions: readonly CaptureSession[],
  now: number,
): ConnectionProfile[] {
  const byRoom = new Map(rooms.map((r) => [r.roomId, r]));
  const roomIds = rooms.map((r) => r.roomId);
  const out = new Map<string, ConnectionProfile>();

  for (const s of sessions) {
    const room = byRoom.get(s.roomId);
    if (!room || !s.connectedAsSlot) continue;
    const key = targetKey(room.host, room.port, s.connectedAsSlot);
    const seen = out.get(`${key}#${room.roomId}`);
    if (seen) {
      seen.lastUsedAt = Math.max(seen.lastUsedAt ?? 0, s.startedAt);
      continue;
    }
    out.set(`${key}#${room.roomId}`, {
      label: shortRoomId(room.roomId, roomIds),
      host: room.host,
      port: room.port,
      slotName: s.connectedAsSlot,
      targetKey: key,
      roomId: room.roomId,
      createdAt: now,
      lastUsedAt: s.startedAt,
    });
  }

  return dedupeByRoom([...out.values()]).keep;
}

export function profileFromLegacyTarget(raw: string | null, now: number): ConnectionProfile | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as { host?: unknown; port?: unknown; slotName?: unknown };
    const host = typeof t.host === 'string' ? t.host : '';
    const port = Number(t.port);
    const slotName = typeof t.slotName === 'string' ? t.slotName : '';
    if (!host || !Number.isFinite(port) || !slotName) return null;
    return {
      label: '',
      host,
      port,
      slotName,
      targetKey: targetKey(host, port, slotName),
      roomId: null,
      createdAt: now,
      lastUsedAt: null,
    };
  } catch {
    return null;
  }
}

/** Une ligne par room, pas par slot. Les profils sans room ne sont jamais fusionnes. */
export function dedupeByRoom(profiles: readonly ConnectionProfile[]): {
  keep: ConnectionProfile[];
  remove: ConnectionProfile[];
} {
  const groups = new Map<string, ConnectionProfile[]>();
  const keep: ConnectionProfile[] = [];
  const remove: ConnectionProfile[] = [];

  for (const p of profiles) {
    if (!p.roomId) {
      keep.push(p);
      continue;
    }
    const g = groups.get(p.roomId);
    if (g) g.push(p);
    else groups.set(p.roomId, [p]);
  }

  for (const group of groups.values()) {
    if (group.length === 1) {
      keep.push(group[0]);
      continue;
    }
    const sorted = sortProfiles(group);
    const winner = { ...sorted[0] };
    if (!winner.label.trim()) {
      const named = sorted.find((p) => p.label.trim());
      if (named) winner.label = named.label;
    }
    keep.push(winner);
    remove.push(...sorted.slice(1));
  }

  return { keep: sortProfiles(keep), remove };
}

export interface RoomLinkFix {
  id: number;
  roomId: string | null;
  /** Vide si c'etait le court-id de l'ancienne room ; un libelle du joueur n'est jamais touche. */
  label?: string;
}

/** Ne corrige que vers une room attestee, jamais en detachant : un slot edite n'a pas de session. */
export function repairRoomLinks(
  profiles: readonly ConnectionProfile[],
  rooms: readonly Pick<Room, 'roomId' | 'host' | 'port'>[],
  sessions: readonly Pick<CaptureSession, 'roomId' | 'connectedAsSlot' | 'startedAt'>[],
): RoomLinkFix[] {
  const byRoom = new Map(rooms.map((r) => [r.roomId, r]));
  const slotsOfRoom = new Map<string, Set<string>>();
  const roomOfTarget = new Map<string, { roomId: string; startedAt: number }>();

  for (const s of sessions) {
    if (!s.connectedAsSlot) continue;
    const slots = slotsOfRoom.get(s.roomId);
    if (slots) slots.add(s.connectedAsSlot);
    else slotsOfRoom.set(s.roomId, new Set([s.connectedAsSlot]));

    const room = byRoom.get(s.roomId);
    if (!room) continue;
    const key = targetKey(room.host, room.port, s.connectedAsSlot);
    const seen = roomOfTarget.get(key);
    if (!seen || s.startedAt > seen.startedAt) {
      roomOfTarget.set(key, { roomId: s.roomId, startedAt: s.startedAt });
    }
  }

  const out: RoomLinkFix[] = [];
  for (const p of profiles) {
    if (p.id === undefined || p.roomId === null) continue;
    const slots = slotsOfRoom.get(p.roomId);
    if (!slots || slots.size === 0) continue;
    if (slots.has(p.slotName)) continue;
    const better = roomOfTarget.get(p.targetKey)?.roomId;
    if (better === undefined || better === p.roomId) continue;
    const derivedLabel = p.label.trim() !== '' && p.roomId.startsWith(p.label.trim());
    out.push({ id: p.id, roomId: better, ...(derivedLabel ? { label: '' } : {}) });
  }
  return out;
}

/** Une ligne deja rattachee n'est jamais re-pointee : l'ancienne partie deviendrait inaccessible. */
export function attachPlan(
  profile: Pick<ConnectionProfile, 'roomId'>,
  roomId: string,
): 'none' | 'link' | 'split' {
  if (profile.roomId === roomId) return 'none';
  return profile.roomId === null ? 'link' : 'split';
}

/** Seules les rooms absentes : sinon un doublon detruit et recree a chaque chargement. */
export function missingProfiles(
  derived: readonly ConnectionProfile[],
  existing: readonly ConnectionProfile[],
): ConnectionProfile[] {
  const covered = new Set(
    existing.map((p) => p.roomId).filter((r): r is string => r !== null),
  );
  return derived.filter((p) => p.roomId === null || !covered.has(p.roomId));
}

export function sortProfiles(profiles: readonly ConnectionProfile[]): ConnectionProfile[] {
  return [...profiles].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || (a.id ?? 0) - (b.id ?? 0));
}
