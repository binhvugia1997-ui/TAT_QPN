/**
 * Shared, defensive access to the browser's own storage for Records display preferences.
 *
 * Every Records preference (which columns are visible, how wide they are) is UI state that
 * lives only in this browser. Storage can be unavailable or throwing — private mode, a locked
 * profile, a quota error — and a preference must never be able to break the application, so
 * callers get `null` here and fall back to their own defaults.
 */

/** Minimal storage surface, so tests and non-browser runtimes can inject their own. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The browser's localStorage, or null outside a browser / when it is not usable. */
export function browserStorage(): PreferenceStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Storage can throw when it is disabled or blocked (private mode, locked profile).
    return null;
  }
}
