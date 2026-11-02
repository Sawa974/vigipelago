import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { ThemeService } from '../core/theme.service';
import type { Theme } from '../core/theme';
import { Dialog } from './dialog';
import { I18n } from '../i18n/i18n.service';
import type { Key } from '../i18n/en';

/** L'apercu porte `.theme-scope`, que `styles.css` traite comme une racine de jetons. */
@Component({
  selector: 'app-theme-dialog',
  imports: [Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './theme-dialog.html',
  styleUrl: './theme-dialog.css',
})
export class ThemeDialog {
  protected readonly theme = inject(ThemeService);
  protected readonly t = inject(I18n).t;
  readonly open = input(false);
  readonly closed = output<void>();

  /** Le theme de l'apercu, distinct du theme applique. */
  protected readonly selected = signal('');
  protected readonly groups = [
    { label: 'theme.dark' as Key, themes: this.theme.themes.filter((th) => th.polarite === 'sombre') },
    { label: 'theme.light' as Key, themes: this.theme.themes.filter((th) => th.polarite === 'claire') },
  ];
  protected readonly preview = computed<Theme>(
    () => this.theme.themes.find((th) => th.id === this.selected()) ?? this.theme.themes[0],
  );

  constructor() {
    effect(() => {
      if (this.open()) this.selected.set(this.theme.courant());
    });
  }

  /** Le theme par defaut a l'id vide. */
  protected themeName(id: string): string {
    return this.t(`theme.name.${id || 'default'}` as Key);
  }

  protected apply(): void {
    this.theme.choisir(this.selected());
  }
}
