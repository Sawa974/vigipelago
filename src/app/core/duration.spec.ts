import { describe, expect, it } from 'vitest';
import { EN, type Key } from '../i18n/en';
import { translate, type Params } from '../i18n/translate';
import { durationLabel } from './duration';

const t = (key: Key, params?: Params) => translate(key, params, 'en', EN, EN);

describe('durationLabel', () => {
  it('reste en minutes sous l heure', () => {
    expect(durationLabel(0, t)).toBe('0 min');
    expect(durationLabel(90_000, t)).toBe('2 min');
    expect(durationLabel(59 * 60_000, t)).toBe('59 min');
  });

  it('passe en heures et complete les minutes', () => {
    expect(durationLabel(60 * 60_000, t)).toBe('1 h 00');
    expect(durationLabel(16 * 3600_000, t)).toBe('16 h 00');
    expect(durationLabel(7 * 3600_000 + 5 * 60_000, t)).toBe('7 h 05');
  });
});
