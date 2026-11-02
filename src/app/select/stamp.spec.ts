import { describe, expect, it } from 'vitest';
import { sameLocalDay, shortStamp } from './stamp';

/** En heure locale : le fuseau du lecteur decide du jour. */
const at = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

describe('sameLocalDay', () => {
  it('compare des jours calendaires, pas un ecart de vingt-quatre heures', () => {
    expect(sameLocalDay(at(2026, 10, 17, 23, 50), at(2026, 10, 18, 0, 10))).toBe(false);
    expect(sameLocalDay(at(2026, 10, 18, 8), at(2026, 10, 18, 20))).toBe(true);
  });

  it('ne confond pas deux mois ni deux annees au meme numero de jour', () => {
    expect(sameLocalDay(at(2026, 9, 18, 12), at(2026, 10, 18, 12))).toBe(false);
    expect(sameLocalDay(at(2025, 10, 18, 12), at(2026, 10, 18, 12))).toBe(false);
  });
});

describe('shortStamp', () => {
  const now = at(2026, 10, 18, 15, 0);

  it("rend l'heure pour un instant du jour", () => {
    const s = shortStamp(at(2026, 10, 18, 9, 5), now, 'fr-FR');
    expect(s.isDay).toBe(false);
    expect(s.text).toBe('09:05');
  });

  it('rend le jour pour un instant d un autre jour', () => {
    const s = shortStamp(at(2026, 10, 17, 23, 50), now, 'fr-FR');
    expect(s.isDay).toBe(true);
    expect(s.text).toBe('17/10');
  });

  it("suit l'ordre des chiffres de la langue du lecteur, sans reglage", () => {
    const d = at(2026, 10, 17, 12);
    expect(shortStamp(d, now, 'fr-FR').text).toBe('17/10');
    expect(shortStamp(d, now, 'en-US').text).toBe('10/17');
  });

  it('garde le jour pour un instant d une autre annee', () => {
    expect(shortStamp(at(2025, 12, 31, 18), now, 'fr-FR')).toEqual({ text: '31/12', isDay: true });
  });
});
