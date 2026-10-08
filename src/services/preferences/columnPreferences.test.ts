import { describe, expect, it } from 'vitest';
import {
  loadVisibleColumns,
  RECORDS_COLUMN_STORAGE_KEY,
  saveVisibleColumns,
  type PreferenceStorage,
} from './columnPreferences';
import { DEFAULT_VISIBLE_COLUMNS, toggleVisibleColumn } from '../../business/records/columnVisibility';
import { REQUIRED_RECORDS_COLUMNS, type RecordsTableColumnKey } from '../../business/records/recordsTable';

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

describe('Records column preference storage', () => {
  it('uses the agreed per-client storage key', () => {
    expect(RECORDS_COLUMN_STORAGE_KEY).toBe('tnp.records.visibleColumns');
  });

  it('returns the default when nothing has been saved yet', () => {
    expect([...loadVisibleColumns(memoryStorage())]).toEqual(ALL);
  });

  it('restores the saved selection on reload', () => {
    const storage = memoryStorage();
    const chosen = toggleVisibleColumn(toggleVisibleColumn(DEFAULT_VISIBLE_COLUMNS, 'mqis'), 'plant');

    saveVisibleColumns(chosen, storage);
    // Simulates reopening the application: a fresh read of the same client storage.
    expect([...loadVisibleColumns(storage)]).toEqual([...chosen]);
  });

  it('survives a simulated component remount', () => {
    const storage = memoryStorage();
    saveVisibleColumns(toggleVisibleColumn(DEFAULT_VISIBLE_COLUMNS, 'occurPlace'), storage);

    const firstMount = loadVisibleColumns(storage);
    const secondMount = loadVisibleColumns(storage);

    expect([...secondMount]).toEqual([...firstMount]);
    expect(secondMount.has('occurPlace')).toBe(false);
  });

  it('writes valid JSON, so the preference is inspectable and portable', () => {
    const storage = memoryStorage();
    saveVisibleColumns(toggleVisibleColumn(DEFAULT_VISIBLE_COLUMNS, 'pic'), storage);

    const raw = storage.dump()[RECORDS_COLUMN_STORAGE_KEY];
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual({ version: 1, hidden: ['pic'] });
  });

  it('falls back safely to the default for corrupt stored data', () => {
    for (const raw of ['not json at all', '{"hidden":', '[]', '{}', '"mqis"', 'null']) {
      const storage = memoryStorage({ [RECORDS_COLUMN_STORAGE_KEY]: raw });
      expect([...loadVisibleColumns(storage)]).toEqual(ALL);
    }
  });

  it('drops an invalid entry but keeps the rest of a partly corrupt preference', () => {
    const storage = memoryStorage({
      [RECORDS_COLUMN_STORAGE_KEY]: JSON.stringify({ version: 1, hidden: ['mqis', 'ghostColumn'] }),
    });
    const visible = loadVisibleColumns(storage);

    expect(visible.has('mqis')).toBe(false);
    expect(visible.size).toBe(ALL.length - 1);
  });

  it('still protects NO, Title and QPN against a hostile stored preference', () => {
    const storage = memoryStorage({
      [RECORDS_COLUMN_STORAGE_KEY]: JSON.stringify({ version: 1, hidden: ALL }),
    });
    const visible = loadVisibleColumns(storage);

    expect(visible.has('no')).toBe(true);
    expect(visible.has('title')).toBe(true);
    expect(visible.has('qpn')).toBe(true);
  });

  it('works when storage is unavailable or throws', () => {
    expect([...loadVisibleColumns(null)]).toEqual(ALL);

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

    expect([...loadVisibleColumns(hostile)]).toEqual(ALL);
    expect(() => saveVisibleColumns(DEFAULT_VISIBLE_COLUMNS, hostile)).not.toThrow();
  });

  it('keeps a column a stored preference never named visible', () => {
    // The preference records hidden columns, so a column it does not mention — including
    // one introduced by a later version — is shown by default rather than hidden forever.
    const storage = memoryStorage({
      [RECORDS_COLUMN_STORAGE_KEY]: JSON.stringify({ version: 1, hidden: ['mqis'] }),
    });
    const visible = loadVisibleColumns(storage);

    expect(visible.has('mqis')).toBe(false);
    expect(visible.size).toBe(ALL.length - 1);
    for (const key of ALL.filter((item) => item !== 'mqis')) {
      expect(visible.has(key)).toBe(true);
    }
  });
});
