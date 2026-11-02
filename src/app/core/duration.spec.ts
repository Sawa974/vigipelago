import { describe, expect, it } from 'vitest';
import { durationLabel } from './duration';

describe('durationLabel', () => {
  it('reste en minutes sous l heure', () => {
    expect(durationLabel(0)).toBe('0 min');
    expect(durationLabel(90_000)).toBe('2 min');
    expect(durationLabel(59 * 60_000)).toBe('59 min');
  });

  it('passe en heures et complete les minutes', () => {
    expect(durationLabel(60 * 60_000)).toBe('1 h 00');
    expect(durationLabel(16 * 3600_000)).toBe('16 h 00');
    expect(durationLabel(7 * 3600_000 + 5 * 60_000)).toBe('7 h 05');
  });
});
