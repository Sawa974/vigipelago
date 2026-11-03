/** `auto` : l'usage de la langue de l'interface ; les autres l'imposent. */
export type DateOrder = 'auto' | 'dm' | 'md';
export type TimeFormat = 'auto' | 'h24' | 'h12';

export const DATE_ORDERS: readonly DateOrder[] = ['auto', 'dm', 'md'];
export const TIME_FORMATS: readonly TimeFormat[] = ['auto', 'h24', 'h12'];

export interface DateStyle {
  order: DateOrder;
  time: TimeFormat;
  /** Indefinie : la langue du navigateur. */
  lang?: string;
}

export const DEFAULT_DATE_STYLE: DateStyle = { order: 'auto', time: 'auto' };

export function isDateOrder(v: unknown): v is DateOrder {
  return DATE_ORDERS.includes(v as DateOrder);
}

export function isTimeFormat(v: unknown): v is TimeFormat {
  return TIME_FORMATS.includes(v as TimeFormat);
}

const two = (n: number) => String(n).padStart(2, '0');

/** `h23` et non `hour12: false`, qui affiche `24:05` a minuit dans certaines langues. */
export function clock(ts: number, style: DateStyle, seconds = false): string {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  if (seconds) opts.second = '2-digit';
  if (style.time === 'h24') opts.hourCycle = 'h23';
  if (style.time === 'h12') opts.hour12 = true;
  try {
    return new Date(ts).toLocaleTimeString(style.lang, opts);
  } catch {
    const d = new Date(ts);
    const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
    return seconds ? `${hm}:${two(d.getSeconds())}` : hm;
  }
}

export function dayMonth(ts: number, style: DateStyle): string {
  const d = new Date(ts);
  if (style.order === 'dm') return `${two(d.getDate())}/${two(d.getMonth() + 1)}`;
  if (style.order === 'md') return `${two(d.getMonth() + 1)}/${two(d.getDate())}`;
  try {
    return d.toLocaleDateString(style.lang, { day: '2-digit', month: '2-digit' });
  } catch {
    return `${two(d.getDate())}/${two(d.getMonth() + 1)}`;
  }
}

export function fullDate(ts: number, style: DateStyle): string {
  const d = new Date(ts);
  if (style.order === 'dm') return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
  if (style.order === 'md') return `${two(d.getMonth() + 1)}/${two(d.getDate())}/${d.getFullYear()}`;
  try {
    return d.toLocaleDateString(style.lang, { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
}

export function dateTime(ts: number, style: DateStyle): string {
  return `${fullDate(ts, style)} ${clock(ts, style, true)}`;
}

/** Sert a regler l'ecart des graduations : une heure sur 12 h est plus large. */
export function usesTwelveHours(style: DateStyle): boolean {
  if (style.time !== 'auto') return style.time === 'h12';
  try {
    return new Intl.DateTimeFormat(style.lang, { hour: 'numeric' }).resolvedOptions().hour12 === true;
  } catch {
    return false;
  }
}
