import { describe, expect, it } from 'vitest';
import { readLanguageFile, type LanguageFile } from './language-file';
import type { Dict } from './translate';

const ref: Dict = {
  'lang.code': 'en',
  'lang.name': 'English',
  'a.hello': 'Hello',
  'a.games': { one: '{count} game', other: '{count} games' },
};

function ok(text: string): LanguageFile {
  const r = readLanguageFile(text, ref, ['en', 'fr']);
  if (typeof r === 'string') throw new Error(r);
  return r;
}

describe('readLanguageFile', () => {
  it('prend le code et le nom dans le fichier', () => {
    const r = ok(JSON.stringify({ 'lang.code': 'DE', 'lang.name': 'Deutsch', 'a.hello': 'Hallo' }));
    expect(r.code).toBe('de');
    expect(r.name).toBe('Deutsch');
    expect(r.dict['a.hello']).toBe('Hallo');
  });

  it('compte les cles manquantes, qui retomberont sur l anglais', () => {
    const r = ok(JSON.stringify({ 'lang.code': 'de', 'lang.name': 'Deutsch' }));
    expect(r.missing.sort()).toEqual(['a.games', 'a.hello']);
  });

  it('ignore les cles inconnues et les entrees du mauvais type', () => {
    const r = ok(
      JSON.stringify({
        'lang.code': 'de',
        'lang.name': 'Deutsch',
        'a.hello': 42,
        'a.games': { one: 'ein Spiel' },
        'z.extra': 'x',
      }),
    );
    expect(r.unknown).toEqual(['z.extra']);
    expect(r.invalid.sort()).toEqual(['a.games', 'a.hello']);
    expect('a.hello' in r.dict).toBe(false);
  });

  it('refuse un fichier qui n est pas un objet JSON', () => {
    expect(readLanguageFile('pas du json', ref, [])).toBe('not-json');
    expect(readLanguageFile('[1,2]', ref, [])).toBe('not-object');
  });

  it('refuse un code absent ou mal forme, et un nom vide', () => {
    expect(readLanguageFile(JSON.stringify({ 'lang.name': 'X' }), ref, [])).toBe('bad-code');
    expect(readLanguageFile(JSON.stringify({ 'lang.code': 'not a code', 'lang.name': 'X' }), ref, [])).toBe('bad-code');
    expect(readLanguageFile(JSON.stringify({ 'lang.code': 'de', 'lang.name': ' ' }), ref, [])).toBe('no-name');
  });

  it('refuse de remplacer une langue livree avec l outil', () => {
    expect(readLanguageFile(JSON.stringify({ 'lang.code': 'fr', 'lang.name': 'Français' }), ref, ['en', 'fr'])).toBe('reserved-code');
  });
});
