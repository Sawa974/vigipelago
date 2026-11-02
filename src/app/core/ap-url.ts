/** Les deux schemas, le plus probable d'abord : clair en local, TLS en distant. */
export function candidateUrls(host: string, port: number): string[] {
  if (/^wss?:\/\//i.test(host)) return [host];
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host);
  const authority = `${host}:${port}`;
  return local ? [`ws://${authority}`, `wss://${authority}`] : [`wss://${authority}`, `ws://${authority}`];
}
