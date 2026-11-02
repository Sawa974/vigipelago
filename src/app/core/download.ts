export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoquer dans la foulee annule le telechargement sur certains navigateurs.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
