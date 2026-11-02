import { EN, type Key } from '../i18n/en';
import { translate, type Dict, type Params } from '../i18n/translate';
import fr from '../../../public/i18n/fr.json';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_STATUS,
  clientStatusKey,
  clientStatusLabel,
  isGoalReached,
  parseClientStatusKey,
  readClientStatus,
  resolveSlotStatus,
} from './client-status';

const tFr = (key: Key, params?: Params) => translate(key, params, 'fr', fr as Dict, EN);

describe('clientStatusKey', () => {
  it('forme la cle du data storage, prefixe compris', () => {
    expect(clientStatusKey(0, 2)).toBe('_read_client_status_0_2');
  });

  it('relit sa propre cle et refuse les autres', () => {
    expect(parseClientStatusKey('_read_client_status_0_2')).toEqual({ team: 0, slot: 2 });
    expect(parseClientStatusKey('_read_hints_0_2')).toBeNull();
    expect(parseClientStatusKey('_read_client_status_0')).toBeNull();
    expect(parseClientStatusKey('client_status_0_2')).toBeNull();
  });
});

describe('isGoalReached', () => {
  it('reconnait l objectif atteint', () => {
    expect(isGoalReached(CLIENT_STATUS.goal)).toBe(true);
    expect(isGoalReached(40)).toBe(true);
  });

  it('ne prend aucun autre etat pour un objectif', () => {
    for (const s of [CLIENT_STATUS.unknown, CLIENT_STATUS.connected, CLIENT_STATUS.ready, CLIENT_STATUS.playing]) {
      expect(isGoalReached(s)).toBe(false);
    }
  });

  it('une absence de donnee n est jamais un objectif atteint', () => {
    expect(isGoalReached(null)).toBe(false);
    expect(isGoalReached(undefined)).toBe(false);
  });
});

describe('readClientStatus', () => {
  it('distingue le zero declare de la cle jamais ecrite', () => {
    expect(readClientStatus(0)).toBe(0);
    expect(readClientStatus(null)).toBeNull();
    expect(readClientStatus(undefined)).toBeNull();
    expect(readClientStatus('30')).toBeNull();
    expect(readClientStatus(NaN)).toBeNull();
  });
});

describe('clientStatusLabel', () => {
  it('nomme chaque etat, et dit que le client le declare', () => {
    expect(clientStatusLabel(CLIENT_STATUS.goal, tFr)).toBe('objectif atteint');
    expect(clientStatusLabel(CLIENT_STATUS.playing, tFr)).toBe('en jeu');
    expect(clientStatusLabel(null, tFr)).toBe('jamais connecté');
    expect(clientStatusLabel(99, tFr)).toBe('état 99');
  });
});

describe('resolveSlotStatus', () => {
  it('prefere le signal de session au stockage', () => {
    const live = new Map([[2, CLIENT_STATUS.goal]]);
    expect(resolveSlotStatus(live, 2, CLIENT_STATUS.playing)).toBe(CLIENT_STATUS.goal);
  });

  it('un slot porte a null par le signal ne retombe pas sur le stockage', () => {
    const live = new Map<number, number | null>([[2, null]]);
    expect(resolveSlotStatus(live, 2, CLIENT_STATUS.playing)).toBeNull();
    expect(resolveSlotStatus(live, 3, CLIENT_STATUS.playing)).toBe(CLIENT_STATUS.playing);
  });

  it('retombe sur le stockage hors connexion, et sur null sans rien', () => {
    const vide = new Map<number, number | null>();
    expect(resolveSlotStatus(vide, 2, CLIENT_STATUS.goal)).toBe(CLIENT_STATUS.goal);
    expect(resolveSlotStatus(vide, 2, undefined)).toBeNull();
    expect(resolveSlotStatus(vide, 2, null)).toBeNull();
  });
});
