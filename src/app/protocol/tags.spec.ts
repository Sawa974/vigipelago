import { describe, expect, it } from 'vitest';
import { classifyTags, VIGIPELAGO_TAG } from './tags';

describe('classifyTags', () => {
  it('reconnait nos propres connexions avant tout le reste', () => {
    expect(classifyTags(['TextOnly', VIGIPELAGO_TAG])).toBe('self');
  });

  it('reconnait encore l ancien nom de l outil, que portent les journaux deja enregistres', () => {
    expect(classifyTags(['TextOnly', 'Mychipelago', 'DeathLink'])).toBe('self');
  });

  it('classe en observateur les clients qui n envoient pas de locations', () => {
    expect(classifyTags(['TextOnly'])).toBe('observer');
    expect(classifyTags(['Tracker'])).toBe('observer');
    expect(classifyTags(['HintGame'])).toBe('observer');
  });

  it('classe en joueur un client sans aucun tag', () => {
    expect(classifyTags([])).toBe('player');
    expect(classifyTags(null)).toBe('player');
    expect(classifyTags(undefined)).toBe('player');
  });

  it('classe en joueur le tag AP, qui ne designe que le client de reference', () => {
    expect(classifyTags(['AP'])).toBe('player');
    expect(classifyTags(['AP', 'DeathLink'])).toBe('player');
  });

  it('privilegie l observateur quand un client cumule les tags', () => {
    expect(classifyTags(['AP', 'Tracker'])).toBe('observer');
  });
});
