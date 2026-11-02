/** `{app}` est toujours remplace par le nom de l'application. */
export type Plural = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
export type Entry = string | Plural;
export type Dict = Readonly<Record<string, Entry>>;
export type Params = Readonly<Record<string, string | number>>;
export type Translate = (key: import('./en').Key, params?: Params) => string;

/** Visible a l'ecran, jamais une chaine vide. */
export function missing(key: string): string {
  return `⟦${key}⟧`;
}

/** Une entree d'un mauvais type dans un fichier importe compte comme absente. */
export function translate(
  key: string,
  params: Params | undefined,
  lang: string,
  dict: Dict,
  fallback: Dict,
): string {
  const entry = usable(dict[key]) ?? usable(fallback[key]);
  if (entry === undefined) return missing(key);
  const text = typeof entry === 'string' ? entry : pluralForm(entry, params?.['count'], lang);
  const app = usable(dict['app.name']) ?? usable(fallback['app.name']);
  return fill(text, { app: typeof app === 'string' ? app : '', ...params });
}

function usable(e: unknown): Entry | undefined {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as Plural).other === 'string') return e as Plural;
  return undefined;
}

function pluralForm(p: Plural, count: string | number | undefined, lang: string): string {
  if (typeof count !== 'number') return p.other;
  let rule: Intl.LDMLPluralRule = 'other';
  try {
    rule = new Intl.PluralRules(lang).select(count);
  } catch {
    /* langue inconnue du navigateur : la forme generale */
  }
  return p[rule] ?? p.other;
}

function fill(text: string, params: Params): string {
  return text.replace(/\{(\w+)\}/g, (all, name: string) =>
    name in params ? String(params[name]) : all,
  );
}

export function pickLanguage(
  stored: string | null,
  browser: readonly string[],
  available: readonly string[],
): string {
  if (stored && available.includes(stored)) return stored;
  for (const tag of browser) {
    const base = tag.toLowerCase().split('-')[0];
    if (available.includes(base)) return base;
  }
  return 'en';
}
