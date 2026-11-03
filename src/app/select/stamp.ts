import { clock, dayMonth, DEFAULT_DATE_STYLE, type DateStyle } from './date-format';

/** Jour calendaire local, jamais `now - ts < 86400000`. */
export function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
  );
}

export interface ShortStamp {
  text: string;
  isDay: boolean;
}

export function shortStamp(ts: number, now: number, style: DateStyle = DEFAULT_DATE_STYLE): ShortStamp {
  if (sameLocalDay(ts, now)) return { text: clock(ts, style), isDay: false };
  return { text: dayMonth(ts, style), isDay: true };
}
