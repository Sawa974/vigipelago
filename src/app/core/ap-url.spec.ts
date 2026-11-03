import { describe, expect, it } from 'vitest';
import { candidateUrls } from './ap-url';

describe('candidateUrls', () => {
  it('essaie le TLS d abord pour un serveur distant, puis le clair si la page le permet', () => {
    expect(candidateUrls('archipelago.gg', 49711, false)).toEqual([
      'wss://archipelago.gg:49711',
      'ws://archipelago.gg:49711',
    ]);
  });

  it('ne propose jamais ws:// distant depuis une page https : le navigateur le bloquerait', () => {
    expect(candidateUrls('archipelago.gg', 49711, true)).toEqual(['wss://archipelago.gg:49711']);
  });

  it('garde ws:// en local, que le navigateur autorise meme depuis https', () => {
    expect(candidateUrls('localhost', 38281, true)).toEqual(['ws://localhost:38281', 'wss://localhost:38281']);
  });

  it('respecte un schema ecrit par l utilisateur', () => {
    expect(candidateUrls('wss://example.org:1234', 0, true)).toEqual(['wss://example.org:1234']);
  });
});
