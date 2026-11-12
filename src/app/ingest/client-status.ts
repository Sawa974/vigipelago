import type { Translate } from '../i18n/translate';

// Declare par le client, jamais deduit des checks : une carte complete peut rester `PLAYING`.

/** Les trous sont dans le protocole. */
export const CLIENT_STATUS = {
  unknown: 0,
  connected: 5,
  ready: 10,
  playing: 20,
  goal: 30,
} as const;

export function clientStatusKey(team: number, slot: number): string {
  return `_read_client_status_${team}_${slot}`;
}

export function parseClientStatusKey(key: string): { team: number; slot: number } | null {
  const m = /^_read_client_status_(\d+)_(\d+)$/.exec(key);
  return m ? { team: Number(m[1]), slot: Number(m[2]) } : null;
}

/** `>=` et non `===` : un etat futur plus avance que `goal` ne doit pas reculer. */
export function isGoalReached(status: number | null | undefined): boolean {
  return typeof status === 'number' && status >= CLIENT_STATUS.goal;
}

/** Le signal fait foi des qu'il porte le slot, meme a `null`. */
export function resolveSlotStatus(
  live: ReadonlyMap<number, number | null>,
  slot: number,
  stored: number | null | undefined,
): number | null {
  if (live.has(slot)) return live.get(slot) ?? null;
  return stored ?? null;
}

/** `null` : cle jamais ecrite, distinct de `unknown` (0) qui est un etat declare. */
export function readClientStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function clientStatusLabel(status: number | null, t: Translate): string {
  switch (status) {
    case CLIENT_STATUS.goal:
      return t('clientStatus.goal');
    case CLIENT_STATUS.playing:
      return t('clientStatus.playing');
    case CLIENT_STATUS.ready:
      return t('clientStatus.ready');
    case CLIENT_STATUS.connected:
      return t('clientStatus.connected');
    case CLIENT_STATUS.unknown:
      return t('clientStatus.unknown');
    default:
      return status === null ? t('clientStatus.never') : t('clientStatus.other', { status });
  }
}
