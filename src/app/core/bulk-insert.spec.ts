import { describe, expect, it } from 'vitest';
import { storedRows } from './bulk-insert';

describe('storedRows', () => {
  it('ecarte les positions refusees par la base', () => {
    const refused = new Error('ConstraintError');
    expect(storedRows(['a', 'b', 'c', 'd'], { 1: refused, 3: refused })).toEqual(['a', 'c']);
  });

  it('garde tout sans refus', () => {
    expect(storedRows(['a', 'b'], {})).toEqual(['a', 'b']);
  });

  it('ne garde rien si tout est refuse', () => {
    const refused = new Error('ConstraintError');
    expect(storedRows(['a'], { 0: refused })).toEqual([]);
  });
});
