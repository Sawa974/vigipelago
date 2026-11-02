import { describe, expect, it } from 'vitest';
import { EN } from './en';
import { missing, pickLanguage, translate, type Dict } from './translate';
import fr from '../../../public/i18n/fr.json';
import { BUILT_IN_LANGUAGES } from './i18n.service';

const EN_DICT: Dict = EN;

describe('translate', () => {
  const sample: Dict = { 'a.b': 'bonjour {name}', 'app.name': 'Vigie' };

  it('prend la langue choisie, puis l anglais, puis montre la cle', () => {
    const en: Dict = { 'a.b': 'hello {name}', 'c.d': 'only english', 'app.name': 'Vigipelago' };
    expect(translate('a.b', { name: 'Bob' }, 'fr', sample, en)).toBe('bonjour Bob');
    expect(translate('c.d', undefined, 'fr', sample, en)).toBe('only english');
    expect(translate('x.y', undefined, 'fr', sample, en)).toBe(missing('x.y'));
  });

  it('remplace toujours {app} par le nom de l application', () => {
    expect(translate('t', undefined, 'fr', { t: 'quand {app} écoute', 'app.name': 'Vigie' }, {})).toBe('quand Vigie écoute');
  });

  it('laisse en place un parametre non fourni plutot que de l effacer', () => {
    expect(translate('a.b', undefined, 'fr', sample, {})).toBe('bonjour {name}');
  });

  it('choisit la forme du pluriel selon la langue', () => {
    const d: Dict = { n: { one: '{count} jeu', other: '{count} jeux' } };
    expect(translate('n', { count: 1 }, 'fr', d, {})).toBe('1 jeu');
    // En francais, zero prend le singulier ; en anglais, le pluriel.
    expect(translate('n', { count: 0 }, 'fr', d, {})).toBe('0 jeu');
    expect(translate('n', { count: 0 }, 'en', { n: { one: '{count} game', other: '{count} games' } }, {})).toBe('0 games');
    expect(translate('n', { count: 3 }, 'fr', d, {})).toBe('3 jeux');
  });

  it('ignore une entree mal formee d un fichier importe', () => {
    const bad = { k: 42, p: { one: 'x' } } as unknown as Dict;
    expect(translate('k', undefined, 'fr', bad, { k: 'ok' })).toBe('ok');
    expect(translate('p', { count: 1 }, 'fr', bad, {})).toBe(missing('p'));
  });
});

describe('pickLanguage', () => {
  const available = ['en', 'fr'];
  it('respecte le choix memorise', () => {
    expect(pickLanguage('fr', ['en-US'], available)).toBe('fr');
  });
  it('suit le navigateur, region comprise', () => {
    expect(pickLanguage(null, ['de-DE', 'fr-FR'], available)).toBe('fr');
  });
  it('retombe sur l anglais', () => {
    expect(pickLanguage('xx', ['de-DE'], available)).toBe('en');
  });
});

describe('les langues livrees', () => {
  // Une langue ajoutee a `BUILT_IN_LANGUAGES` doit l'etre ici.
  const files: Record<string, Record<string, unknown>> = { fr };

  it('chaque langue livree a son fichier', () => {
    expect(BUILT_IN_LANGUAGES.filter((l) => l !== 'en').sort()).toEqual(Object.keys(files).sort());
  });

  for (const [lang, dict] of Object.entries(files)) {
    it(`${lang}.json a exactement les cles de l anglais, et des pluriels complets`, () => {
      expect(Object.keys(dict).sort()).toEqual(Object.keys(EN_DICT).sort());
      for (const [key, value] of Object.entries(dict)) {
        const ref = EN_DICT[key];
        expect(typeof value, key).toBe(typeof ref);
        if (typeof value === 'object') expect(typeof (value as { other?: unknown }).other, key).toBe('string');
      }
    });
  }
});
