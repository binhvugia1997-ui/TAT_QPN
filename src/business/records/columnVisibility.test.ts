import { describe, expect, it } from 'vitest';
import {
  applyColumnVisibility,
  COLUMN_PREFERENCE_VERSION,
  DEFAULT_VISIBLE_COLUMNS,
  normalizeVisibleColumns,
  PROTECTED_RECORDS_COLUMNS,
  resetVisibleColumns,
  SELECTABLE_RECORDS_COLUMNS,
  selectAllColumns,
  serializeColumnPreference,
  toggleVisibleColumn,
  totalColumnWidth,
} from './columnVisibility';
import {
  RECORDS_TABLE_COLUMNS,
  REQUIRED_RECORDS_COLUMNS,
  type RecordsTableColumnKey,
} from './recordsTable';

const ALL: RecordsTableColumnKey[] = REQUIRED_RECORDS_COLUMNS.map(({ key }) => key);

describe('column selector surface', () => {
  it('offers exactly the 14 approved Records columns', () => {
    expect(SELECTABLE_RECORDS_COLUMNS.map(({ key }) => key)).toEqual(ALL);
    expect(SELECTABLE_RECORDS_COLUMNS).toHaveLength(14);
  });

  it('does not offer the corrective CA badge, so that workspace keeps its own column', () => {
    expect(SELECTABLE_RECORDS_COLUMNS.some(({ key }) => key === 'caLink')).toBe(false);
    expect(RECORDS_TABLE_COLUMNS.some(({ key }) => key === 'caLink')).toBe(true);
  });

  it('protects NO, Title and QPN from being hidden', () => {
    expect(PROTECTED_RECORDS_COLUMNS).toEqual(['no', 'title', 'qpn']);
  });

  it('defaults to every approved column visible', () => {
    expect([...DEFAULT_VISIBLE_COLUMNS]).toEqual(ALL);
  });
});

describe('toggling columns', () => {
  it('hides only the unchecked column', () => {
    const next = toggleVisibleColumn(DEFAULT_VISIBLE_COLUMNS, 'mqis');

    expect(next.has('mqis')).toBe(false);
    expect(next.size).toBe(ALL.length - 1);
    for (const key of ALL) {
      if (key !== 'mqis') expect(next.has(key)).toBe(true);
    }
  });

  it('restores a column when it is checked again', () => {
    const hidden = toggleVisibleColumn(DEFAULT_VISIBLE_COLUMNS, 'mqis');

    expect(toggleVisibleColumn(hidden, 'mqis').has('mqis')).toBe(true);
    expect([...toggleVisibleColumn(hidden, 'mqis')]).toEqual(ALL);
  });

  it('refuses to hide a protected column', () => {
    for (const key of PROTECTED_RECORDS_COLUMNS) {
      expect(toggleVisibleColumn(DEFAULT_VISIBLE_COLUMNS, key).has(key)).toBe(true);
    }
  });

  it('never returns the same set instance, so callers see a real change', () => {
    expect(toggleVisibleColumn(DEFAULT_VISIBLE_COLUMNS, 'mqis')).not.toBe(DEFAULT_VISIBLE_COLUMNS);
  });

  it('select all makes every approved column visible again', () => {
    let state = DEFAULT_VISIBLE_COLUMNS;
    for (const key of ALL) state = toggleVisibleColumn(state, key);

    expect([...selectAllColumns()]).toEqual(ALL);
  });

  it('reset default returns the application default from any state', () => {
    let state = toggleVisibleColumn(toggleVisibleColumn(DEFAULT_VISIBLE_COLUMNS, 'mqis'), 'pic');

    expect([...resetVisibleColumns()]).toEqual(ALL);
    expect(state.size).toBe(ALL.length - 2);
  });

  it('cannot be reduced below the protected columns', () => {
    let state = DEFAULT_VISIBLE_COLUMNS;
    for (const key of ALL) state = toggleVisibleColumn(state, key);

    expect([...state].sort()).toEqual([...PROTECTED_RECORDS_COLUMNS].sort());
  });
});

describe('stored preference safety', () => {
  it('falls back to the default when there is no preference', () => {
    expect([...normalizeVisibleColumns(null)]).toEqual(ALL);
    expect([...normalizeVisibleColumns(undefined)]).toEqual(ALL);
  });

  it('falls back to the default for malformed or wrongly shaped input', () => {
    for (const bad of ['nope', 42, true, {}, { hidden: 'mqis' }, { hidden: 7 }, [], [[]]]) {
      expect([...normalizeVisibleColumns(bad)]).toEqual(ALL);
    }
  });

  it('ignores unknown keys from a preference written by another version', () => {
    const stored = { version: 1, hidden: ['mqis', 'notARealColumn', 99, null] };

    const visible = normalizeVisibleColumns(stored);
    expect(visible.has('mqis')).toBe(false);
    expect(visible.size).toBe(ALL.length - 1);
  });

  it('refuses to hide a protected column even if an old preference says so', () => {
    const visible = normalizeVisibleColumns({ version: 1, hidden: ['no', 'title', 'qpn', 'pic'] });

    expect(visible.has('no')).toBe(true);
    expect(visible.has('title')).toBe(true);
    expect(visible.has('qpn')).toBe(true);
    expect(visible.has('pic')).toBe(false);
  });

  it('keeps every column an older preference never named visible, so a new column appears by default', () => {
    // This is the migration guarantee. The stored form lists what is *hidden*, so a
    // preference written by an earlier version can only ever hide the columns it knew
    // about; any column it never names — including one a later version introduces —
    // appears by default and is never permanently hidden.
    const stored = { version: 1, hidden: ['mqis'] };
    const visible = normalizeVisibleColumns(stored);

    expect(visible.has('mqis')).toBe(false);
    for (const key of ALL.filter((item) => item !== 'mqis')) {
      expect(visible.has(key)).toBe(true);
    }
  });

  it('round-trips a selection through the stored form', () => {
    const state = toggleVisibleColumn(toggleVisibleColumn(DEFAULT_VISIBLE_COLUMNS, 'mqis'), 'plant');
    const stored = serializeColumnPreference(state);

    expect(stored).toEqual({ version: COLUMN_PREFERENCE_VERSION, hidden: ['mqis', 'plant'] });
    expect([...normalizeVisibleColumns(stored)]).toEqual([...state]);
  });

  it('stores hidden keys in column order, not selection order', () => {
    const state = toggleVisibleColumn(toggleVisibleColumn(DEFAULT_VISIBLE_COLUMNS, 'pendingDays'), 'mqis');

    expect(serializeColumnPreference(state).hidden).toEqual(['mqis', 'pendingDays']);
  });
});

describe('applying visibility to a rendered table', () => {
  it('removes hidden columns and keeps the approved order', () => {
    const visible = new Set<RecordsTableColumnKey>(ALL.filter((key) => key !== 'plant'));

    expect(applyColumnVisibility(REQUIRED_RECORDS_COLUMNS, visible).map(({ key }) => key))
      .toEqual(ALL.filter((key) => key !== 'plant'));
  });

  it('always keeps the corrective CA badge, which the selector does not manage', () => {
    const visible = new Set<RecordsTableColumnKey>(['no', 'title', 'qpn']);

    const rendered = applyColumnVisibility(RECORDS_TABLE_COLUMNS, visible).map(({ key }) => key);
    expect(rendered).toEqual(['no', 'title', 'qpn', 'caLink']);
  });

  it('reports the total width of the visible columns so the table can size itself', () => {
    expect(totalColumnWidth(REQUIRED_RECORDS_COLUMNS))
      .toBe(REQUIRED_RECORDS_COLUMNS.reduce((sum, { width }) => sum + width, 0));
    expect(totalColumnWidth(applyColumnVisibility(REQUIRED_RECORDS_COLUMNS, new Set(['no'])))).toBe(52);
    expect(totalColumnWidth([])).toBe(0);
  });
});
