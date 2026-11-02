import { describe, expect, it } from 'vitest';
import { offlineMessage } from './offline-message';
import { EN } from '../i18n/en';
import { translate, type Dict } from '../i18n/translate';
import fr from '../../../public/i18n/fr.json';

describe('offlineMessage', () => {
  it('dit quoi corriger quand le mot de passe est refuse', () => {
    expect(offlineMessage('fatal', ['InvalidPassword'])).toBe('offline.password');
  });

  it('renvoie vers Modifier quand le slot est inconnu', () => {
    expect(offlineMessage('fatal', ['InvalidSlot'])).toBe('offline.slot');
  });

  it('le refus l emporte sur l etat', () => {
    expect(offlineMessage('fatal', ['InvalidPassword'])).not.toBe(offlineMessage('fatal'));
  });

  it('reste comprehensible sur un code inconnu du protocole', () => {
    expect(offlineMessage('fatal', ['SomethingNew'])).toBe('offline.refused');
  });

  it('distingue un serveur muet d une connexion perdue', () => {
    expect(offlineMessage('unreachable')).not.toBe(offlineMessage('backoff'));
  });

  /** L'ecran peut etre en stream : aucun message ne doit nommer le serveur. */
  it('ne peut nommer ni hote ni port dans aucun cas', () => {
    const states = [
      'idle',
      'connecting',
      'handshake',
      'online',
      'backoff',
      'unreachable',
      'fatal',
    ] as const;
    const refusals = [[], ['InvalidPassword'], ['InvalidSlot'], ['Autre']];
    for (const s of states) {
      for (const r of refusals) {
        for (const dict of [EN, fr] as Dict[]) {
          const msg = translate(offlineMessage(s, r), undefined, 'fr', dict, EN);
          expect(msg).not.toMatch(/localhost|ws:|wss:|:\d{2,5}\b|⟦/);
          expect(msg.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
