import type { SocketState } from './ap-socket';
import type { Key } from '../i18n/en';

type OfflineKey = Extract<Key, `offline.${string}`>;

/** Ne prend volontairement ni hote, ni port, ni URL : l'ecran peut etre en stream. */
export function offlineMessage(state: SocketState, refusal: readonly string[] = []): OfflineKey {
  if (refusal.includes('InvalidPassword')) return 'offline.password';
  if (refusal.includes('InvalidSlot')) return 'offline.slot';
  if (refusal.includes('IncompatibleVersion')) return 'offline.version';
  if (refusal.includes('InvalidGame')) return 'offline.game';
  if (refusal.length) return 'offline.refused';

  switch (state) {
    case 'unreachable':
      return 'offline.unreachable';
    case 'connecting':
    case 'handshake':
      return 'offline.connecting';
    case 'backoff':
      return 'offline.backoff';
    case 'fatal':
      return 'offline.fatal';
    default:
      return 'offline.none';
  }
}
