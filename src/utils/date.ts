export type DateOnly = string;
const MS_PER_DAY = 86_400_000;

function partsToDateOnly(year: number, month: number, day: number): DateOnly {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid calendar date: ${year}-${month}-${day}`);
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Normalize accepted date inputs to an ISO calendar date without local-DST arithmetic. */
export function normalizeDateOnly(value: unknown, fieldName = 'date'): DateOnly | null {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new RangeError(`Invalid date value for ${fieldName}.`);
    }
    // Match the legacy import's Date-to-ISO behavior.
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`Invalid date serial for ${fieldName}.`);
    // Excel's 1900 date system uses 1899-12-30 as the serial-day epoch.
    const timestamp = Date.UTC(1899, 11, 30) + Math.round(value * MS_PER_DAY);
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date serial for ${fieldName}.`);
    return date.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  if (!text) return null;

  const yearFirst = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/u.exec(text);
  if (yearFirst) {
    return partsToDateOnly(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
  }

  // Preserve the calendar date for other parseable source strings without converting
  // local midnight to the previous UTC day. ISO timestamps were handled above.
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`Could not normalize ${fieldName}: ${text}`);
  }
  return partsToDateOnly(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

export function isDateOnly(value: unknown): value is DateOnly {
  if (typeof value !== 'string') return false;
  try {
    return normalizeDateOnly(value) === value;
  } catch {
    return false;
  }
}

export function addCalendarDays(date: DateOnly | null | undefined, days: number): DateOnly | null {
  if (!date) return null;
  if (!Number.isInteger(days)) throw new RangeError('Calendar-day offset must be an integer.');
  const normalized = normalizeDateOnly(date);
  if (!normalized) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return partsToDateOnly(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
}

/** Return a local calendar date; UTC is used only for arithmetic on date-only values. */
export function todayDateOnly(now = new Date()): DateOnly {
  return partsToDateOnly(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function differenceInCalendarDays(target: DateOnly, reference: DateOnly): number {
  const normalizedTarget = normalizeDateOnly(target);
  const normalizedReference = normalizeDateOnly(reference);
  if (!normalizedTarget || !normalizedReference) {
    throw new RangeError('Both dates are required for calendar-day difference.');
  }
  const [ty, tm, td] = normalizedTarget.split('-').map(Number);
  const [ry, rm, rd] = normalizedReference.split('-').map(Number);
  return (Date.UTC(ty, tm - 1, td) - Date.UTC(ry, rm - 1, rd)) / MS_PER_DAY;
}

export function daysUntil(date: DateOnly | null | undefined, today = todayDateOnly()): number | null {
  if (!date) return null;
  try {
    return differenceInCalendarDays(date, today);
  } catch {
    return null;
  }
}
