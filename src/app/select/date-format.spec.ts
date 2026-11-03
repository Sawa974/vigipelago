import { describe, expect, it } from 'vitest';
import { clock, dateTime, dayMonth, isDateOrder, isTimeFormat, usesTwelveHours, type DateStyle } from './date-format';

/** En heure locale : le fuseau du lecteur decide du jour. */
const at = (y: number, m: number, d: number, h: number, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s).getTime();

const style = (over: Partial<DateStyle>): DateStyle => ({ order: 'auto', time: 'auto', ...over });

describe('dayMonth', () => {
  const d = at(2026, 8, 3, 21, 5);

  it('suit la langue en automatique', () => {
    expect(dayMonth(d, style({ lang: 'fr' }))).toBe('03/08');
    expect(dayMonth(d, style({ lang: 'en-US' }))).toBe('08/03');
  });

  it('impose l ordre choisi quelle que soit la langue', () => {
    expect(dayMonth(d, style({ order: 'dm', lang: 'en-US' }))).toBe('03/08');
    expect(dayMonth(d, style({ order: 'md', lang: 'fr' }))).toBe('08/03');
  });
});

describe('clock', () => {
  const d = at(2026, 11, 3, 21, 5, 9);

  it('suit la langue en automatique', () => {
    expect(clock(d, style({ lang: 'fr' }))).toBe('21:05');
    expect(clock(d, style({ lang: 'en-US' }))).toMatch(/^09:05\sPM$/u);
  });

  it('impose 24 h ou 12 h quelle que soit la langue', () => {
    expect(clock(d, style({ time: 'h24', lang: 'en-US' }), true)).toBe('21:05:09');
    expect(clock(d, style({ time: 'h12', lang: 'fr' }))).toMatch(/^09:05\s?PM$/iu);
  });

  it('ne passe jamais par 24:05 a minuit', () => {
    expect(clock(at(2026, 11, 3, 0, 5), style({ time: 'h24', lang: 'en-US' }))).toBe('00:05');
  });
});

describe('dateTime', () => {
  it('assemble la date et l heure du meme style', () => {
    const d = at(2026, 11, 3, 21, 5, 9);
    expect(dateTime(d, style({ order: 'md', time: 'h24', lang: 'fr' }))).toBe('11/03/2026 21:05:09');
    expect(dateTime(d, style({ order: 'dm', time: 'h24', lang: 'en-US' }))).toBe('03/11/2026 21:05:09');
  });
});

describe('usesTwelveHours', () => {
  it('lit l usage de la langue en automatique', () => {
    expect(usesTwelveHours(style({ lang: 'en-US' }))).toBe(true);
    expect(usesTwelveHours(style({ lang: 'fr' }))).toBe(false);
    expect(usesTwelveHours(style({ time: 'h12', lang: 'fr' }))).toBe(true);
  });
});

describe('reglages stockes', () => {
  it('refusent une valeur inconnue', () => {
    expect(isDateOrder('dm')).toBe(true);
    expect(isDateOrder('ymd')).toBe(false);
    expect(isTimeFormat('h12')).toBe(true);
    expect(isTimeFormat(null)).toBe(false);
  });
});
