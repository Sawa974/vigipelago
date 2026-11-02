import { computed, Injectable, signal } from '@angular/core';
import { EN, type Key } from './en';
import { pickLanguage, translate, type Dict, type Params } from './translate';

export const LANG_KEY = 'vigipelago.lang';
export const IMPORTED_LANGS_KEY = 'vigipelago.langs';

/** L'anglais vit dans le code, les autres dans `public/i18n`. */
export const BUILT_IN_LANGUAGES = ['en', 'fr'] as const;
const BUILT_IN_NAMES: Record<(typeof BUILT_IN_LANGUAGES)[number], string> = {
  en: 'English',
  fr: 'Français',
};

export interface Language {
  code: string;
  name: string;
  builtIn: boolean;
}

interface Imported {
  name: string;
  dict: Dict;
}

@Injectable({ providedIn: 'root' })
export class I18n {
  readonly lang = signal('en');
  private readonly dict = signal<Dict>(EN);
  private readonly imported = signal<Record<string, Imported>>(readImported());

  readonly languages = computed<Language[]>(() => [
    ...BUILT_IN_LANGUAGES.map((code) => ({ code, name: BUILT_IN_NAMES[code], builtIn: true })),
    ...Object.entries(this.imported()).map(([code, l]) => ({ code, name: l.name, builtIn: false })),
  ]);

  /** Flechee pour etre passee telle quelle aux composants. */
  readonly t = (key: Key, params?: Params): string =>
    translate(key, params, this.lang(), this.dict(), EN);

  async init(): Promise<void> {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LANG_KEY);
    } catch {
      /* stockage inaccessible : la langue du navigateur decide */
    }
    const codes = this.languages().map((l) => l.code);
    await this.use(pickLanguage(stored, navigator.languages ?? [navigator.language], codes));
  }

  async choose(lang: string): Promise<void> {
    await this.use(lang);
    try {
      localStorage.setItem(LANG_KEY, this.lang());
    } catch {
      /* le choix vaut pour cette visite */
    }
  }

  addLanguage(code: string, name: string, dict: Dict): void {
    this.imported.update((all) => ({ ...all, [code]: { name, dict } }));
    writeImported(this.imported());
  }

  async removeLanguage(code: string): Promise<void> {
    this.imported.update((all) => {
      const next = { ...all };
      delete next[code];
      return next;
    });
    writeImported(this.imported());
    if (this.lang() === code) await this.choose('en');
  }

  private async use(lang: string): Promise<void> {
    let dict: Dict = EN;
    const own = this.imported()[lang];
    if (own) {
      dict = own.dict;
    } else if (lang !== 'en') {
      try {
        const res = await fetch(`i18n/${lang}.json`);
        if (res.ok) dict = (await res.json()) as Dict;
        else lang = 'en';
      } catch {
        lang = 'en';
      }
    }
    this.dict.set(dict);
    this.lang.set(lang);
    document.documentElement.lang = lang;
  }

  /** Dans la langue de l'interface, et non celle du systeme. */
  datetime(ts: number): string {
    try {
      return new Date(ts).toLocaleString(this.lang());
    } catch {
      return new Date(ts).toLocaleString();
    }
  }
}

function readImported(): Record<string, Imported> {
  try {
    const raw = localStorage.getItem(IMPORTED_LANGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Imported>) : {};
  } catch {
    return {};
  }
}

function writeImported(all: Record<string, Imported>): void {
  try {
    localStorage.setItem(IMPORTED_LANGS_KEY, JSON.stringify(all));
  } catch {
    /* stockage plein ou refuse : la langue reste pour cette visite */
  }
}
