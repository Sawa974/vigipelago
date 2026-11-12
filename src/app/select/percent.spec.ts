import { describe, expect, it } from 'vitest';
import { truncPercent } from './percent';

describe('truncPercent', () => {
  it('ne perd pas un centieme sur les valeurs que la virgule flottante rate', () => {
    expect(truncPercent(29, 100)).toBe('29.00');
    expect(truncPercent(57, 100)).toBe('57.00');
    expect(truncPercent(58, 100)).toBe('58.00');
  });

  it('tronque au lieu d arrondir', () => {
    expect(truncPercent(2, 3)).toBe('66.66');
    expect(truncPercent(1365, 1366)).toBe('99.92');
    expect(truncPercent(99996, 100000)).toBe('99.99');
  });

  it('rend les bornes', () => {
    expect(truncPercent(0, 1366)).toBe('0.00');
    expect(truncPercent(1366, 1366)).toBe('100.00');
    expect(truncPercent(1400, 1366)).toBe('100.00');
  });
});
