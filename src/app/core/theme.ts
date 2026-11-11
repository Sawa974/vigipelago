/** `id` est la valeur de `data-theme` ; `''` est le defaut, sans attribut. */
export type Polarite = 'sombre' | 'claire';

export interface Theme {
  readonly id: string;
  readonly polarite: Polarite;
}

export const THEMES: readonly Theme[] = [
  { id: '', polarite: 'sombre' },
  { id: 'foret-or', polarite: 'sombre' },
  { id: 'brique-cuivre', polarite: 'sombre' },
  { id: 'encre-magenta', polarite: 'sombre' },
  { id: 'mario', polarite: 'sombre' },
  { id: 'mario-feu', polarite: 'claire' },
  { id: 'creme-azur', polarite: 'claire' },
];

export const THEME_KEY = 'vigipelago.theme';

/** Pour l'amorcage de `public/theme-init.js`, qui ne connait pas la liste des themes. */
export const POLARITE_KEY = 'vigipelago.polarite';

/** Un `data-theme` sans regle CSS laisserait l'interface a moitie peinte. */
export function themeValide(brut: string | null): string {
  return THEMES.some((t) => t.id === brut) ? (brut as string) : '';
}

export interface PorteurDAttributs {
  setAttribute(nom: string, valeur: string): void;
  removeAttribute(nom: string): void;
}

export function appliqueTheme(racine: PorteurDAttributs, id: string): Theme {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  if (theme.id) racine.setAttribute('data-theme', theme.id);
  else racine.removeAttribute('data-theme');
  if (theme.polarite === 'claire') racine.setAttribute('data-polarite', 'claire');
  else racine.removeAttribute('data-polarite');
  return theme;
}
