import type { Translate } from '../i18n/translate';

export function durationLabel(ms: number, t: Translate): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return t('unit.minutes', { min });
  return t('unit.hours', { h: Math.floor(min / 60), min: String(min % 60).padStart(2, '0') });
}
