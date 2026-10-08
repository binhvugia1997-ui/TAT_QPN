import { describe, expect, it } from 'vitest';
import {
  clearColumnWidths,
  COLUMN_WIDTH_PREFERENCE_VERSION,
  loadColumnWidths,
  normalizeColumnWidthPreference,
  RECORDS_COLUMN_WIDTH_STORAGE_KEY,
  saveColumnWidths,
} from './columnWidthPreferences';
import type { PreferenceStorage } from './columnPreferences';
import { defaultColumnWidths } from '../../business/records/columnWidths';
import { REQUIRED_RECORDS_COLUMNS, type RecordsTableColumnKey } from '../../business/records/recordsTable';

const defaults = defaultColumnWidths(REQUIRED_RECORDS_COLUMNS);
const ALL: RecordsTableColumnKey[] = REQUIRED_RECORDS_COLUMNS.map(({ key }) => key);

/** In-memory stand-in for window.localStorage. */
function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { dump: () => Record<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    dump: () => Object.fromEntries(store),
  };
}

const raw = (storage: ReturnType<typeof memoryStorage>): unknown =>
  JSON.parse(storage.dump()[RECORDS_COLUMN_WIDTH_STORAGE_KEY] as string);

describe('Records column width storage', () => {
  it('uses its own key, so a width preference cannot damage the visibility preference', () => {
    expect(RECORDS_COLUMN_WIDTH_STORAGE_KEY).toBe('tnp.records.columnWidths');
    expect(RECORDS_COLUMN_WIDTH_STORAGE_KEY).not.toBe('tnp.records.visibleColumns');
  });

  it('has nothing stored for an untouched table', () => {
    expect(loadColumnWidths(defaults, memoryStorage())).toEqual({});
  });

  it('round-trips a resized column through a reload', () => {
    const storage = memoryStorage();

    saveColumnWidths({ mqis: 300 }, defaults, storage);

    // Simulates reopening the application: a fresh read of the same client storage.
    expect(loadColumnWidths(defaults, storage)).toEqual({ mqis: 300 });
    expect(raw(storage)).toEqual({ version: COLUMN_WIDTH_PREFERENCE_VERSION, widths: { mqis: 300 } });
  });

  it('keeps every resized column and the approved column order is unaffected', () => {
    const storage = memoryStorage();
    saveColumnWidths({ mqis: 300, title: 420, plant: 60 }, defaults, storage);

    const loaded = loadColumnWidths(defaults, storage);
    expect(loaded).toEqual({ mqis: 300, title: 420, plant: 60 });
    expect(Object.keys(loaded)).toHaveLength(3);
    expect(ALL).toHaveLength(14);
  });

  it('does not store a width equal to the approved default', () => {
    const storage = memoryStorage();
    saveColumnWidths({ mqis: defaults.mqis }, defaults, storage);

    expect(raw(storage)).toEqual({ version: 1, widths: {} });
    expect(loadColumnWidths(defaults, storage)).toEqual({});
  });

  it('a reset writes an empty map, so the width does not come back on reload', () => {
    const storage = memoryStorage();
    saveColumnWidths({ mqis: 300 }, defaults, storage);
    saveColumnWidths({}, defaults, storage);

    expect(loadColumnWidths(defaults, storage)).toEqual({});
  });

  it('clearColumnWidths removes the preference entirely', () => {
    const storage = memoryStorage();
    saveColumnWidths({ mqis: 300, title: 420 }, defaults, storage);
    expect(storage.dump()[RECORDS_COLUMN_WIDTH_STORAGE_KEY]).toBeDefined();

    clearColumnWidths(storage);

    expect(storage.dump()[RECORDS_COLUMN_WIDTH_STORAGE_KEY]).toBeUndefined();
    expect(loadColumnWidths(defaults, storage)).toEqual({});
  });

  it('rejects corrupt, hostile and wrong-shaped stored data', () => {
    for (const value of ['not json', '{"widths":', '[]', '"mqis"', 'null', '7', '{}']) {
      const storage = memoryStorage({ [RECORDS_COLUMN_WIDTH_STORAGE_KEY]: value });
      expect(loadColumnWidths(defaults, storage)).toEqual({});
    }
  });

  it('drops an unusable entry but keeps the rest of a partly corrupt preference', () => {
    const storage = memoryStorage({
      [RECORDS_COLUMN_WIDTH_STORAGE_KEY]: JSON.stringify({
        version: 1,
        widths: { mqis: 300, title: 'huge', plant: -20, pic: null },
      }),
    });

    expect(loadColumnWidths(defaults, storage)).toEqual({ mqis: 300 });
  });

  it('ignores a column the table no longer has', () => {
    const storage = memoryStorage({
      [RECORDS_COLUMN_WIDTH_STORAGE_KEY]: JSON.stringify({ version: 1, widths: { ghostColumn: 400, mqis: 220 } }),
    });

    expect(loadColumnWidths(defaults, storage)).toEqual({ mqis: 220 });
  });

  it('accepts the bare widths map as well as the versioned object', () => {
    expect(normalizeColumnWidthPreference({ mqis: 260 }, defaults)).toEqual({ mqis: 260 });
    expect(normalizeColumnWidthPreference({ version: 1, widths: { mqis: 260 } }, defaults)).toEqual({ mqis: 260 });
  });

  it('clamps an out-of-range stored width into the usable bounds', () => {
    expect(normalizeColumnWidthPreference({ mqis: 100_000 }, defaults).mqis).toBeLessThanOrEqual(640);
    expect(normalizeColumnWidthPreference({ mqis: 1 }, defaults).mqis).toBeGreaterThanOrEqual(48);
  });

  it('works when storage is unavailable or throws', () => {
    expect(loadColumnWidths(defaults, null)).toEqual({});

    const hostile: PreferenceStorage = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      },
    };

    expect(loadColumnWidths(defaults, hostile)).toEqual({});
    expect(() => saveColumnWidths({ mqis: 300 }, defaults, hostile)).not.toThrow();
    expect(() => clearColumnWidths(hostile)).not.toThrow();
  });

  it('is a display preference only: nothing is sent anywhere', () => {
    // The whole module reads and writes a key in one storage object; it has no import of the
    // API client, the record service or the database, so a width cannot reach SQLite.
    const storage = memoryStorage();
    saveColumnWidths({ mqis: 300 }, defaults, storage);

    expect(Object.keys(storage.dump())).toEqual([RECORDS_COLUMN_WIDTH_STORAGE_KEY]);
  });
});
