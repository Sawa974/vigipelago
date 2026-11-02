import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { download } from '../core/download';
import { EN, type Key } from '../i18n/en';
import { BUILT_IN_LANGUAGES, I18n } from '../i18n/i18n.service';
import { readLanguageFile, type LanguageFile } from '../i18n/language-file';
import { Dialog } from './dialog';

@Component({
  selector: 'app-language-dialog',
  imports: [Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './language-dialog.html',
  styleUrl: './language-dialog.css',
})
export class LanguageDialog {
  protected readonly i18n = inject(I18n);
  protected readonly t = this.i18n.t;
  readonly open = input(false);
  readonly closed = output<void>();

  protected readonly selected = signal('en');
  protected readonly builtIn = computed(() => this.i18n.languages().filter((l) => l.builtIn));
  protected readonly imported = computed(() => this.i18n.languages().filter((l) => !l.builtIn));
  protected readonly report = signal<LanguageFile | null>(null);
  protected readonly error = signal<Key | null>(null);

  constructor() {
    effect(() => {
      if (this.open()) {
        this.selected.set(this.i18n.lang());
        this.report.set(null);
        this.error.set(null);
      }
    });
  }

  protected apply(): void {
    void this.i18n.choose(this.selected());
  }

  protected downloadTemplate(): void {
    const json = JSON.stringify(EN, null, 2) + '\n';
    download(new Blob([json], { type: 'application/json' }), 'vigipelago-language-template.json');
  }

  protected async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.report.set(null);
    this.error.set(null);
    const result = readLanguageFile(await file.text(), EN, BUILT_IN_LANGUAGES);
    if (typeof result === 'string') {
      this.error.set(`lang.err.${result}`);
      return;
    }
    this.i18n.addLanguage(result.code, result.name, result.dict);
    this.selected.set(result.code);
    this.report.set(result);
  }

  protected remove(code: string): void {
    void this.i18n.removeLanguage(code);
    if (this.selected() === code) this.selected.set('en');
  }
}
