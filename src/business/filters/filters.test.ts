import { describe, expect, it } from 'vitest';
import type { DefectRecord } from '../../models/defect-record';
import { applyRecordFilters, buildRecordsHref, createEmptyFilters, EMPTY_FILTER_QUERY_VALUE, getFilterOptions, parseRecordFilters, sortRecords, sortRecordsByValue, toggleColumnSort, writeRecordFilters } from './filters';

const row = (id: number, overrides: Partial<DefectRecord> = {}): DefectRecord => ({
  id,
  recordSource: 'legacy-seed',
  mgmtNo: `M-${id}`,
  status: 'Đợi đối sách',
  registeredDate: '2026-10-01',
  plant: 'SEV',
  ...overrides,
});

describe('record filters and sorting', () => {
  it('combines search, inclusive date bounds and selected facets', () => {
    const records = [
      row(1, { title: 'Rear case scratch', registeredDate: '2026-10-01', partGroup: 'Rear' }),
      row(2, { title: 'Front case crack', registeredDate: '2026-10-02', partGroup: 'Front' }),
      row(3, { title: 'Rear case chip', registeredDate: '2026-10-03', partGroup: 'Rear' }),
    ];
    const filters = { ...createEmptyFilters(), search: 'rear', dateFrom: '2026-10-01', dateTo: '2026-10-02', partGroup: new Set(['Rear']) };
    expect(applyRecordFilters(records, filters).map((record) => record.id)).toEqual([1]);
  });

  it('can isolate records with a missing plant value', () => {
    const records = [row(1, { plant: null }), row(2, { plant: 'SEV' })];
    expect(applyRecordFilters(records, { ...createEmptyFilters(), plant: new Set(['']) }).map((record) => record.id)).toEqual([1]);
  });

  it('includes app-managed PIC, Remark and CA link in the shared search', () => {
    const records = [
      row(1, { pic: 'Lan Anh', notes: 'Waiting for supplier confirmation' }),
      row(2, { caFileLink: 'file:///local/ca/repair-plan.xlsx' }),
      row(3, { title: 'Unrelated defect' }),
    ];
    expect(applyRecordFilters(records, { ...createEmptyFilters(), search: 'lan anh' }).map((record) => record.id)).toEqual([1]);
    expect(applyRecordFilters(records, { ...createEmptyFilters(), search: 'repair-plan' }).map((record) => record.id)).toEqual([2]);
  });

  it('finds a record by the manual "Tên lỗi" text typed in the table, and by its imported source text', () => {
    const records = [
      row(1, { manualDefectName: 'Bracket cracked at the weld', defectDetails: 'Loang' }),
      row(2, { defectDetails: 'Paint peel' }),
    ];

    // The column shows the manual value, so searching for it must work.
    expect(applyRecordFilters(records, { ...createEmptyFilters(), search: 'cracked at the weld' }).map((record) => record.id)).toEqual([1]);
    // The imported source text stays searchable as well.
    expect(applyRecordFilters(records, { ...createEmptyFilters(), search: 'paint peel' }).map((record) => record.id)).toEqual([2]);
    expect(applyRecordFilters(records, { ...createEmptyFilters(), search: 'loang' }).map((record) => record.id)).toEqual([1]);
  });

  it('does not mutate the caller when sorting', () => {
    const records = [row(1, { registeredDate: '2026-10-01' }), row(2, { registeredDate: '2026-10-03' })];
    const sorted = sortRecords(records, 'registeredDate', 'desc');
    expect(sorted.map((record) => record.id)).toEqual([2, 1]);
    expect(records.map((record) => record.id)).toEqual([1, 2]);
  });

  it('sorts date values in either direction, keeps blanks last, and preserves ties without mutation', () => {
    const records = [
      row(1, { registeredDate: '2026-10-03' }),
      row(2, { registeredDate: null }),
      row(3, { registeredDate: '2026-10-01' }),
      row(4, { registeredDate: '2026-10-01' }),
    ];
    expect(sortRecordsByValue(records, (record) => record.registeredDate, 'asc').map((item) => item.id)).toEqual([3, 4, 1, 2]);
    expect(sortRecordsByValue(records, (record) => record.registeredDate, 'desc').map((item) => item.id)).toEqual([1, 3, 4, 2]);
    expect(records.map((item) => item.id)).toEqual([1, 2, 3, 4]);
  });

  it('toggles a selected table column from ascending to descending', () => {
    const firstClick = toggleColumnSort(null, 'registeredDate');
    expect(firstClick).toEqual({ column: 'registeredDate', direction: 'asc' });
    expect(toggleColumnSort(firstClick, 'registeredDate')).toEqual({ column: 'registeredDate', direction: 'desc' });
    expect(toggleColumnSort(firstClick, 'plant')).toEqual({ column: 'plant', direction: 'asc' });
  });

  it('round-trips shared dashboard filters into a Records drill-down subset', () => {
    const filters = {
      ...createEmptyFilters(),
      plant: new Set(['SEV']),
      status: new Set(['Rejected (xét)']),
      reason1: new Set(['']),
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
    };
    const href = buildRecordsHref(filters, { tat: 'overdue' });
    const url = new URL(href, 'https://local.test');
    const restored = parseRecordFilters(url.searchParams);
    const records = [
      row(1, { plant: 'SEV', status: 'Rejected (xét)', reason1: null, registeredDate: '2026-10-12' }),
      row(2, { plant: 'SEV', status: 'Đợi đối sách', reason1: null, registeredDate: '2026-10-12' }),
      row(3, { plant: 'SEVT', status: 'Rejected (xét)', reason1: null, registeredDate: '2026-10-12' }),
      row(4, { plant: 'SEV', status: 'Rejected (xét)', reason1: null, registeredDate: '2026-09-30' }),
    ];

    expect(url.pathname).toBe('/records');
    expect(url.searchParams.get('tat')).toBe('overdue');
    expect(applyRecordFilters(records, restored).map((record) => record.id)).toEqual([1]);

    const missingPlantUrl = new URL(buildRecordsHref(createEmptyFilters(), { plant: EMPTY_FILTER_QUERY_VALUE }), 'https://local.test');
    expect(applyRecordFilters([row(5, { plant: null }), row(6, { plant: 'SEV' })], parseRecordFilters(missingPlantUrl.searchParams))
      .map((record) => record.id)).toEqual([5]);
  });

  it('normalizes duplicate filter query keys while preserving unrelated route state', () => {
    const original = new URLSearchParams('search=first&search=duplicate&plant=stale&plant=old&tat=overdue&view=active');
    const filters = {
      ...createEmptyFilters(),
      search: 'bearing',
      plant: new Set(['SEV']),
      status: new Set(['Rejected (xét)']),
    };
    const next = writeRecordFilters(original, filters);

    expect(next.getAll('search')).toEqual(['bearing']);
    expect(next.getAll('plant')).toEqual(['SEV']);
    expect(next.getAll('status')).toEqual(['Rejected (xét)']);
    expect(next.get('tat')).toBe('overdue');
    expect(next.get('view')).toBe('active');
  });

  it('creates options from data and sorts months newest first', () => {
    const options = getFilterOptions([
      row(1, { registeredDate: '2026-09-10', plant: 'SEV' }),
      row(2, { registeredDate: '2026-10-01', plant: 'SEVT' }),
    ]);
    expect(options.plant).toEqual(['SEV', 'SEVT']);
    expect(options.month).toEqual(['2026-10', '2026-09']);
  });
});
