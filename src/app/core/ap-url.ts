/** Page servie en `https` : le navigateur y bloque tout `ws://` distant. */
export function pageIsSecure(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

/** Les schemas permis, le plus probable d'abord : clair en local, TLS en distant. */
export function candidateUrls(host: string, port: number, secure = pageIsSecure()): string[] {
  if (/^wss?:\/\//i.test(host)) return [host];
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host);
  const authority = `${host}:${port}`;
  if (local) return [`ws://${authority}`, `wss://${authority}`];
  return secure ? [`wss://${authority}`] : [`wss://${authority}`, `ws://${authority}`];
}
