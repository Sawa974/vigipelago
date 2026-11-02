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

/** `locale` indefinie hors tests : l'ordre jour/mois suit le navigateur. */
export function shortStamp(ts: number, now: number, locale?: string): ShortStamp {
  const d = new Date(ts);
  if (sameLocalDay(ts, now)) {
    return {
      text: d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
      isDay: false,
    };
  }
  return {
    text: d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }),
    isDay: true,
  };
}
