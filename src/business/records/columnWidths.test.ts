import { describe, expect, it } from 'vitest';
import {
  MAX_RECORDS_COLUMN_WIDTH,
  MIN_RECORDS_COLUMN_WIDTH,
  applyColumnWidths,
  clampColumnWidth,
  columnWidthsToStore,
  computeColumnLayout,
  defaultColumnWidths,
  measureScrollWidth,
  parseStoredColumnWidth,
  resetAllColumnWidths,
  resetColumnWidth,
  resizedColumnWidth,
} from './columnWidths';
import { RECORDS_TABLE_COLUMNS, REQUIRED_RECORDS_COLUMNS } from './recordsTable';
import type { RecordsTableColumn, RecordsTableColumnKey } from './recordsTable';
import { naturalTextCompare } from '../../utils/naturalCompare';

const column = (key: RecordsTableColumnKey, width: number): RecordsTableColumn => ({
  key,
  label: 'noColumn',
  width,
});

/** The approved spec, exactly as the table declares it. */
const spec = REQUIRED_RECORDS_COLUMNS.map(({ key, width }) => column(key, width));
const defaults = defaultColumnWidths(REQUIRED_RECORDS_COLUMNS);

describe('column width bounds', () => {
  it('keeps a width inside the usable range', () => {
    expect(clampColumnWidth(200, 130)).toBe(200);
    expect(clampColumnWidth(1, 130)).toBe(MIN_RECORDS_COLUMN_WIDTH);
    expect(clampColumnWidth(99_999, 130)).toBe(MAX_RECORDS_COLUMN_WIDTH);
  });

  it('falls back to the column default when the stored value is unusable', () => {
    for (const bad of [null, undefined, 'not a number', Number.NaN, Infinity, -5, 0, {}, [], true, false]) {
      expect(clampColumnWidth(bad, 130)).toBe(130);
    }
  });

  it('reports an unusable stored width as absent rather than as a width', () => {
    expect(parseStoredColumnWidth(240)).toBe(240);
    expect(parseStoredColumnWidth('240.6')).toBe(241);
    for (const bad of [null, undefined, '', 'x', 0, -1, Number.NaN, {}, []]) {
      expect(parseStoredColumnWidth(bad)).toBeNull();
    }
  });

  it('rounds a fractional width to a whole pixel', () => {
    expect(clampColumnWidth(213.4, 100)).toBe(213);
    expect(clampColumnWidth(213.6, 100)).toBe(214);
  });
});

describe('resizing by drag', () => {
  it('is the start width plus the pointer delta', () => {
    expect(resizedColumnWidth({ startWidth: 130, startPointerClientX: 500, pointerClientX: 560 })).toBe(190);
    expect(resizedColumnWidth({ startWidth: 130, startPointerClientX: 500, pointerClientX: 455 })).toBe(85);
  });

  it('is independent of where the drag started in the viewport', () => {
    // Same 40px delta, different absolute positions: the result must match.
    const a = resizedColumnWidth({ startWidth: 200, startPointerClientX: 12, pointerClientX: 52 });
    const b = resizedColumnWidth({ startWidth: 200, startPointerClientX: 1200, pointerClientX: 1240 });
    expect(a).toBe(240);
    expect(b).toBe(a);
  });

  it('clamps at both ends so a drag cannot crush or explode a column', () => {
    expect(resizedColumnWidth({ startWidth: 100, startPointerClientX: 0, pointerClientX: -10_000 }))
      .toBe(MIN_RECORDS_COLUMN_WIDTH);
    expect(resizedColumnWidth({ startWidth: 100, startPointerClientX: 0, pointerClientX: 1_000_000 }))
      .toBe(MAX_RECORDS_COLUMN_WIDTH);
  });

  it('keeps the current width when the gesture reports a nonsense position', () => {
    expect(resizedColumnWidth({ startWidth: 210, startPointerClientX: 0, pointerClientX: Number.NaN })).toBe(210);
    expect(resizedColumnWidth({ startWidth: 210, startPointerClientX: Number.NaN, pointerClientX: 260 })).toBe(210);
  });
});

describe('applying stored widths to the table', () => {
  it('overrides only the columns that were resized', () => {
    const resized = applyColumnWidths(spec, { mqis: 260 });

    expect(resized.find(({ key }) => key === 'mqis')!.width).toBe(260);
    expect(resized.find(({ key }) => key === 'title')!.width).toBe(200);
    // The input spec is never mutated.
    expect(spec.find(({ key }) => key === 'mqis')!.width).toBe(130);
  });

  it('keeps the approved column order and count', () => {
    const resized = applyColumnWidths(spec, { mqis: 260, plant: 120 });

    expect(resized.map(({ key }) => key)).toEqual(spec.map(({ key }) => key));
  });

  it('ignores a width for a column the table no longer has', () => {
    const resized = applyColumnWidths(spec, { ghostColumn: 999 } as never);

    expect(resized.map(({ width }) => width)).toEqual(spec.map(({ width }) => width));
  });

  it('applies to whatever subset is currently rendered, in that subset order', () => {
    const visible = spec.filter(({ key }) => key !== 'mqis' && key !== 'plant');
    const resized = applyColumnWidths(visible, { title: 400 });

    expect(resized.map(({ key }) => key)).toEqual(visible.map(({ key }) => key));
    expect(resized.find(({ key }) => key === 'title')!.width).toBe(400);
  });

  it('clamps a hostile stored width into range', () => {
    expect(applyColumnWidths(spec, { mqis: 10_000 })[1]!.width).toBe(MAX_RECORDS_COLUMN_WIDTH);
    expect(applyColumnWidths(spec, { mqis: 1 })[1]!.width).toBe(MIN_RECORDS_COLUMN_WIDTH);
  });
});

describe('the stored width map', () => {
  it('stores only widths that differ from the approved default', () => {
    expect(columnWidthsToStore({ mqis: 130 }, defaults)).toEqual({});
    expect(columnWidthsToStore({ mqis: 260, title: 200 }, defaults)).toEqual({ mqis: 260 });
  });

  it('drops unknown columns and clamps known ones before storing', () => {
    expect(columnWidthsToStore({ ghost: 300, mqis: 10_000 } as never, defaults)).toEqual({ mqis: MAX_RECORDS_COLUMN_WIDTH });
  });

  it('round-trips through the same clamping the loader applies', () => {
    const stored = columnWidthsToStore({ mqis: 1, title: 240 }, defaults);

    expect(stored).toEqual({ mqis: MIN_RECORDS_COLUMN_WIDTH, title: 240 });
    expect(applyColumnWidths(spec, stored).find(({ key }) => key === 'mqis')!.width)
      .toBe(MIN_RECORDS_COLUMN_WIDTH);
  });

  it('resets one column without disturbing the others', () => {
    const widths = { mqis: 260, title: 240 };

    expect(resetColumnWidth(widths, 'mqis')).toEqual({ title: 240 });
    // Resetting an untouched column is a no-op, so it cannot trigger a pointless write.
    expect(resetColumnWidth(widths, 'pic')).toBe(widths);
    expect(resetAllColumnWidths()).toEqual({});
  });
});

describe('responsive table layout', () => {
  it('gives every column a percentage share of the natural width', () => {
    const columns = [column('no', 50), column('mqis', 150)];
    // 50/200 and 150/200 — the shares are proportional, not equal.
    const layout = computeColumnLayout({ columns, availableWidth: null });

    expect(layout.naturalWidth).toBe(200);
    expect(layout.minWidth).toBe(200);
    expect(layout.percentages.no).toBeCloseTo(25, 6);
    expect(layout.percentages.mqis).toBeCloseTo(75, 6);
  });

  it('always accounts for exactly 100% across the visible columns', () => {
    for (const availableWidth of [null, 400, 1_000, 2_500]) {
      const layout = computeColumnLayout({ columns: spec, availableWidth });
      const total = Object.values(layout.percentages).reduce((sum, value) => sum + value, 0);
      expect(total).toBeCloseTo(100, 6);
    }
  });

  it('scales every column up with the window, in proportion, rather than leaving dead space', () => {
    // Percentages are what let `table-layout: fixed` fill the table; a px colgroup cannot.
    const layout = computeColumnLayout({ columns: spec, availableWidth: 3_000 });
    const mqisShare = layout.percentages.mqis!;
    const natural = layout.naturalWidth;

    const naturalMqis = spec.find(({ key }) => key === 'mqis')!.width;
    expect(mqisShare).toBeCloseTo((naturalMqis / natural) * 100, 4);
    // At a wide window the column really does get more px than its default, and the ratio
    // between two columns is preserved exactly — that is what "responsive" means here.
    expect((mqisShare / 100) * 3_000).toBeGreaterThan(naturalMqis);
    expect(((layout.percentages.no! / 100) * 3_000) / ((mqisShare / 100) * 3_000))
      .toBeCloseTo(layout.percentages.no! / mqisShare, 6);
  });

  it('reports scrolling only when the container is narrower than the natural width', () => {
    const natural = spec.reduce((sum, { width }) => sum + width, 0);

    expect(computeColumnLayout({ columns: spec, availableWidth: natural - 10 }).scrolls).toBe(true);
    expect(computeColumnLayout({ columns: spec, availableWidth: natural }).scrolls).toBe(false);
    expect(computeColumnLayout({ columns: spec, availableWidth: natural + 400 }).scrolls).toBe(false);
    // An unmeasured container is not treated as narrow: the layout degrades to the old sizing.
    expect(computeColumnLayout({ columns: spec, availableWidth: null }).scrolls).toBe(false);
  });

  it('reflects a manual width in both the minimum and the share', () => {
    const widened = applyColumnWidths(spec, { mqis: 400 });
    const base = computeColumnLayout({ columns: spec, availableWidth: null });
    const resizedLayout = computeColumnLayout({ columns: widened, availableWidth: null });

    expect(resizedLayout.naturalWidth).toBe(base.naturalWidth + (400 - 130));
    expect(resizedLayout.minWidth).toBeGreaterThan(base.minWidth);
    expect(resizedLayout.percentages.mqis!).toBeGreaterThan(base.percentages.mqis!);
  });

  it('survives an empty column set', () => {
    const layout = computeColumnLayout({ columns: [], availableWidth: 500 });

    expect(layout).toEqual({ percentages: {}, minWidth: 0, naturalWidth: 0, scrolls: false });
  });

  it('uses clientWidth when it is measurable and scrollWidth only as a fallback', () => {
    expect(measureScrollWidth(1_024, 1_810)).toBe(1_024);
    // jsdom and other hosts with no layout report 0; a 0 clientWidth must not collapse the table.
    expect(measureScrollWidth(0, 1_810)).toBe(1_810);
    expect(measureScrollWidth(0, 0)).toBeNull();
    expect(measureScrollWidth(undefined, undefined)).toBeNull();
    expect(measureScrollWidth('abc', null)).toBeNull();
  });

  it('treats a non-finite measurement as unmeasured', () => {
    expect(measureScrollWidth(Number.NaN, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('keeps the corrective-only CA column in the layout when that workspace renders it', () => {
    const columns = RECORDS_TABLE_COLUMNS.map(({ key, width }) => column(key, width));
    const layout = computeColumnLayout({ columns, availableWidth: null });

    expect(layout.percentages.caLink).toBeGreaterThan(0);
    expect(Object.values(layout.percentages).reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);
  });
});

describe('natural comparison of code-like values', () => {
  it('orders digit runs numerically, which is what MQIS sorting needs', () => {
    expect(naturalTextCompare('MQIS-2', 'MQIS-10')).toBeLessThan(0);
    expect(naturalTextCompare('MQIS-10', 'MQIS-2')).toBeGreaterThan(0);
    expect(naturalTextCompare('2', '10')).toBeLessThan(0);
  });

  it('is consistent', () => {
    const values = ['0007-A', '0010-A', '0100-A', '1', '', 'a', 'B-2', 'B-10'];
    const sorted = [...values].sort(naturalTextCompare);

    // Sorting the same input twice gives the same answer, and the reverse sort is the mirror.
    expect([...values].sort(naturalTextCompare)).toEqual(sorted);
    expect([...values].sort((a, b) => naturalTextCompare(b, a))).toEqual([...sorted].reverse());
  });

  it('treats equal strings as equal', () => {
    expect(naturalTextCompare('TNP-0007', 'TNP-0007')).toBe(0);
  });

  it('breaks a numeric tie on digit count, so padded and unpadded values order deterministically', () => {
    expect(naturalTextCompare('7', '007')).toBeLessThan(0);
    expect(naturalTextCompare('007', '0007')).toBeLessThan(0);
  });

  it('prefers a shorter run list, so a bare prefix sorts before its numbered children', () => {
    expect(naturalTextCompare('MQIS', 'MQIS-1')).toBeLessThan(0);
  });
});
