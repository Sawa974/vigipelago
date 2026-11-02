import { describe, expect, it } from 'vitest';
import { THEMES, appliqueTheme, themeValide } from './theme';

function porteur(initial?: string) {
  const attrs = new Map<string, string>();
  if (initial !== undefined) attrs.set('data-theme', initial);
  return {
    setAttribute: (n: string, v: string) => void attrs.set(n, v),
    removeAttribute: (n: string) => void attrs.delete(n),
    lu: () => attrs.get('data-theme'),
    pose: () => attrs.has('data-theme'),
    polarite: () => attrs.get('data-polarite'),
  };
}

describe('themeValide', () => {
  it('accepte un theme declare', () => {
    expect(themeValide('foret-or')).toBe('foret-or');
  });

  it('retombe sur le defaut quand rien n_est stocke', () => {
    expect(themeValide(null)).toBe('');
  });

  it('refuse une valeur inconnue plutot que de la poser', () => {
    expect(themeValide('theme-retire-depuis')).toBe('');
    expect(themeValide('')).toBe('');
  });

  it('chaque theme a un identifiant unique et un nom', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(THEMES.every((t) => t.nom.length > 0)).toBe(true);
  });

  it('le theme par defaut est sombre', () => {
    expect(THEMES[0].id).toBe('');
    expect(THEMES[0].polarite).toBe('sombre');
  });
});

describe('appliqueTheme', () => {
  it('pose l_attribut pour un theme nomme', () => {
    const el = porteur();
    appliqueTheme(el, 'foret-or');
    expect(el.lu()).toBe('foret-or');
  });

  it('retire l_attribut pour le defaut', () => {
    const el = porteur('foret-or');
    appliqueTheme(el, '');
    expect(el.pose()).toBe(false);
  });

  it('annonce la polarite claire, et elle seule', () => {
    const clair = porteur();
    appliqueTheme(clair, 'mario-feu');
    expect(clair.polarite()).toBe('claire');

    const sombre = porteur();
    appliqueTheme(sombre, 'foret-or');
    expect(sombre.polarite()).toBeUndefined();
  });

  it('retire la polarite en revenant a un theme sombre', () => {
    const el = porteur();
    appliqueTheme(el, 'mario-feu');
    appliqueTheme(el, 'foret-or');
    expect(el.polarite()).toBeUndefined();
  });

  it('ramene tout au defaut pour un identifiant inconnu', () => {
    const el = porteur();
    appliqueTheme(el, 'mario-feu');
    appliqueTheme(el, 'theme-retire-depuis');
    expect(el.pose()).toBe(false);
    expect(el.polarite()).toBeUndefined();
  });
});
