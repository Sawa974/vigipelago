/** La reconnexion doit finir : un serveur eteint et une coupure passagere se ressemblent. */
export type RetryDecision = 'retry' | 'unreachable';

export interface RetryContext {
  everOnline: boolean;
  autoRetry: boolean;
  /** Celle qui vient d'echouer comprise. */
  attempts: number;
  candidates: number;
}

/** Avec le backoff de la socket, huit tentatives couvrent environ 90 s. */
export const RECONNECT_ATTEMPTS = 8;

export function decideRetry(c: RetryContext): RetryDecision {
  if (c.autoRetry) return 'retry';
  // Le premier echec peut n'etre que le mauvais des deux schemas.
  if (c.attempts < c.candidates) return 'retry';
  if (c.everOnline) return c.attempts < RECONNECT_ATTEMPTS ? 'retry' : 'unreachable';
  return 'unreachable';
}
