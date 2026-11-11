import type { Dict, Entry } from './translate';

export interface LanguageFile {
  code: string;
  name: string;
  dict: Dict;
  missing: string[];
  unknown: string[];
  invalid: string[];
}

export type LanguageFileError = 'not-json' | 'not-object' | 'bad-code' | 'no-name' | 'reserved-code';

const CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

/** Un code d'une langue livree est refuse : il la remplacerait en silence. */
export function readLanguageFile(
  text: string,
  reference: Dict,
  reserved: readonly string[],
): LanguageFile | LanguageFileError {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'not-json';
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not-object';
  const obj = raw as Record<string, unknown>;

  const code = typeof obj['lang.code'] === 'string' ? obj['lang.code'].trim().toLowerCase() : '';
  if (!CODE.test(code)) return 'bad-code';
  if (reserved.includes(code)) return 'reserved-code';
  const name = typeof obj['lang.name'] === 'string' ? obj['lang.name'].trim() : '';
  if (!name) return 'no-name';

  const dict: Record<string, Entry> = {};
  const unknown: string[] = [];
  const invalid: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (!Object.hasOwn(reference, key)) {
      unknown.push(key);
      continue;
    }
    if (!isEntry(value, reference[key])) {
      invalid.push(key);
      continue;
    }
    dict[key] = value;
  }
  const missing = Object.keys(reference).filter((k) => !Object.hasOwn(dict, k) &&!invalid.includes(k));
  return { code, name, dict: { ...dict, 'lang.code': code, 'lang.name': name }, missing, unknown, invalid };
}

function isEntry(value: unknown, ref: Entry): value is Entry {
  if (typeof ref === 'string') return typeof value === 'string';
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).every((v) => typeof v === 'string') && typeof (value as { other?: unknown }).other === 'string';
}
