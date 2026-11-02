import { Injectable, signal } from '@angular/core';
import { POLARITE_KEY, THEMES, THEME_KEY, appliqueTheme, themeValide } from './theme';

/** `localStorage` et non Dexie : lecture synchrone, lue aussi par l'amorcage de `index.html`. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly themes = THEMES;
  readonly courant = signal<string>('');

  constructor() {
    let stocke: string | null = null;
    try {
      stocke = localStorage.getItem(THEME_KEY);
    } catch {
      /* stockage refuse : defaut. */
    }
    this.poser(themeValide(stocke));
  }

  choisir(brut: string): void {
    this.poser(themeValide(brut));
  }

  private poser(id: string): void {
    const theme = appliqueTheme(document.documentElement, id);
    this.courant.set(theme.id);
    try {
      if (theme.id) localStorage.setItem(THEME_KEY, theme.id);
      else localStorage.removeItem(THEME_KEY);
      if (theme.polarite === 'claire') localStorage.setItem(POLARITE_KEY, 'claire');
      else localStorage.removeItem(POLARITE_KEY);
    } catch {
      /* stockage refuse : le choix vaut pour la session. */
    }
  }
}
