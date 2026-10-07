import { isDateOnly } from './date';
import type { Locale } from '../i18n';

/**
 * Formats a stored ISO calendar date for display. Anything that is not a valid
 * date-only value renders as the em dash placeholder rather than an Invalid Date.
 */
export function displayDate(value: string | null | undefined, locale: Locale): string {
  if (!value || !isDateOnly(value)) return '—';
  const languageTag = locale === 'vi' ? 'vi-VN' : locale === 'ko' ? 'ko-KR' : 'en-GB';
  return new Intl.DateTimeFormat(languageTag, { day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(`${value}T00:00:00`));
}
