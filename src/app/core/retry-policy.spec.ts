import { describe, expect, it } from 'vitest';
import { decideRetry, RECONNECT_ATTEMPTS, type RetryContext } from './retry-policy';

const base: RetryContext = { everOnline: false, autoRetry: false, attempts: 1, candidates: 2 };

describe('decideRetry', () => {
  it('retente une connexion qui avait abouti, le temps d une coupure reseau', () => {
    expect(decideRetry({ ...base, everOnline: true, attempts: RECONNECT_ATTEMPTS - 1 })).toBe(
      'retry',
    );
  });

  it('rend la main quand la connexion ne revient pas', () => {
    expect(decideRetry({ ...base, everOnline: true, attempts: RECONNECT_ATTEMPTS })).toBe(
      'unreachable',
    );
    expect(decideRetry({ ...base, everOnline: true, attempts: 99 })).toBe('unreachable');
  });

  it('retente sans fin quand la case est cochee, meme apres avoir abouti', () => {
    expect(decideRetry({ ...base, everOnline: true, autoRetry: true, attempts: 99 })).toBe(
      'retry',
    );
  });

  it('laisse sa chance au second schema avant de conclure', () => {
    expect(decideRetry({ ...base, attempts: 1, candidates: 2 })).toBe('retry');
  });

  it('declare la cible injoignable quand tous les schemas ont echoue', () => {
    expect(decideRetry({ ...base, attempts: 2, candidates: 2 })).toBe('unreachable');
  });

  it('conclut des le premier echec quand il n y a qu une url', () => {
    expect(decideRetry({ ...base, attempts: 1, candidates: 1 })).toBe('unreachable');
  });

  it('retente quand le joueur a demande des reessais periodiques', () => {
    expect(decideRetry({ ...base, autoRetry: true, attempts: 50, candidates: 2 })).toBe('retry');
  });
});
