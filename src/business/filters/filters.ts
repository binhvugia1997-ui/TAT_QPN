import type { DefectRecord } from '../../models/defect-record';

export type RecordFilterKey =
  | 'plant'
  | 'project'
  | 'partGroup'
  | 'model'
  | 'occurPlace'
  | 'reason1'
  | 'status'
  | 'month'
  | 'defectCode';

export interface RecordFilters {
  search: string;
  dateFrom: string;
  dateTo: string;
  plant: ReadonlySet<string>;
  project: ReadonlySet<string>;
  partGroup: ReadonlySet<string>;
  model: ReadonlySet<string>;
  occurPlace: ReadonlySet<string>;
  reason1: ReadonlySet<string>;
  status: ReadonlySet<string>;
  month: ReadonlySet<string>;
  defectCode: ReadonlySet<string>;
}

export type FilterOptions = Record<RecordFilterKey, string[]>;
export type SortDirection = 'asc' | 'desc';

export const EMPTY_FILTER_QUERY_VALUE = '__empty__';
const FILTER_QUERY_KEYS: readonly RecordFilterKey[] = [
  'plant', 'project', 'partGroup', 'model', 'occurPlace', 'reason1', 'status', 'month', 'defectCode',
];

/** Parse the same canonical filters from dashboard drill-down and Records URLs. */
export function parseRecordFilters(params: URLSearchParams): RecordFilters {
  const filters = createEmptyFilters();
  filters.search = params.get('search') ?? '';
  filters.dateFrom = params.get('dateFrom') ?? '';
  filters.dateTo = params.get('dateTo') ?? '';
  for (const key of FILTER_QUERY_KEYS) {
    const values = params.getAll(key).map((value) => value === EMPTY_FILTER_QUERY_VALUE ? '' : value);
    if (values.length) filters[key] = new Set(values);
  }
  return filters;
}

/** Replace filter parameters while preserving unrelated route state such as view/TAT scope. */
export function writeRecordFilters(params: URLSearchParams, filters: RecordFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ['search', 'dateFrom', 'dateTo', ...FILTER_QUERY_KEYS]) next.delete(key);
  if (filters.search) next.set('search', filters.search);
  if (filters.dateFrom) next.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) next.set('dateTo', filters.dateTo);
  for (const key of FILTER_QUERY_KEYS) {
    for (const value of filters[key]) {
      next.append(key, value === '' ? EMPTY_FILTER_QUERY_VALUE : value);
    }
  }
  return next;
}

/** Build a durable Records drill-down URL; segment parameters override the same filter key. */
export function buildRecordsHref(
  filters: RecordFilters,
  segment: Readonly<Record<string, string | null | undefined>> = {},
): string {
  const params = writeRecordFilters(new URLSearchParams(), filters);
  for (const [key, value] of Object.entries(segment)) {
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return `/records${query ? `?${query}` : ''}`;
}

export interface ColumnSortState<Column extends string> {
  column: Column;
  direction: SortDirection;
}

export function toggleColumnSort<Column extends string>(
  current: ColumnSortState<Column> | null,
  column: Column,
): ColumnSortState<Column> {
  if (current?.column !== column) return { column, direction: 'asc' };
  return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

function text(value: unknown): string {
  return String(value || '');
}

export function createEmptyFilters(): RecordFilters {
  return {
    search: '',
    dateFrom: '',
    dateTo: '',
    plant: new Set(),
    project: new Set(),
    partGroup: new Set(),
    model: new Set(),
    occurPlace: new Set(),
    reason1: new Set(),
    status: new Set(),
    month: new Set(),
    defectCode: new Set(),
  };
}

export function applyRecordFilters(
  records: readonly DefectRecord[],
  filters: RecordFilters,
): DefectRecord[] {
  const query = filters.search.trim().toLowerCase();
  return records.filter((record) => {
    if (query) {
      const haystack = [
        record.mgmtNo,
        record.mqisCode,
        record.title,
        record.defectDetails,
        record.partName,
        record.partCode,
        record.model,
        record.project,
        record.inspector,
        record.pic,
        record.notes,
        record.caFileLink,
        record.reason1,
        record.supplier,
        record.dueDate,
      ].map((value) => text(value).toLowerCase()).join(' | ');
      if (!haystack.includes(query)) return false;
    }

    // Keep the legacy behavior: records missing registeredDate pass the range checks.
    if (filters.dateFrom && record.registeredDate && record.registeredDate < filters.dateFrom) return false;
    if (filters.dateTo && record.registeredDate && record.registeredDate > filters.dateTo) return false;
    if (filters.plant.size && !filters.plant.has(text(record.plant))) return false;
    if (filters.project.size && !filters.project.has(text(record.project))) return false;
    if (filters.partGroup.size && !filters.partGroup.has(text(record.partGroup))) return false;
    if (filters.model.size && !filters.model.has(text(record.model))) return false;
    if (filters.occurPlace.size && !filters.occurPlace.has(text(record.occurPlace))) return false;
    if (filters.reason1.size && !filters.reason1.has(text(record.reason1))) return false;
    if (filters.status.size && !filters.status.has(text(record.status))) return false;
    if (filters.month.size && !filters.month.has(record.registeredDate?.slice(0, 7) || '')) return false;
    if (filters.defectCode.size && !filters.defectCode.has(text(record.partCode))) return false;
    return true;
  });
}

function uniqueSorted(values: readonly (string | null | undefined)[], descending = false): string[] {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
  return descending ? unique.reverse() : unique;
}

export function getFilterOptions(records: readonly DefectRecord[]): FilterOptions {
  return {
    plant: uniqueSorted(records.map((record) => record.plant)),
    project: uniqueSorted(records.map((record) => record.project)),
    partGroup: uniqueSorted(records.map((record) => record.partGroup)),
    model: uniqueSorted(records.map((record) => record.model)),
    occurPlace: uniqueSorted(records.map((record) => record.occurPlace)),
    reason1: uniqueSorted(records.map((record) => record.reason1)),
    status: uniqueSorted(records.map((record) => record.status)),
    month: uniqueSorted(records.map((record) => record.registeredDate?.slice(0, 7)), true),
    defectCode: uniqueSorted(records.map((record) => record.partCode)),
  };
}

export function sortRecordsByValue<T>(
  records: readonly T[],
  valueOf: (record: T) => unknown,
  direction: SortDirection = 'asc',
): T[] {
  const factor = direction === 'asc' ? 1 : -1;
  return records
    .map((record, index) => ({ record, index, value: valueOf(record) }))
    .sort((left, right) => {
      const leftMissing = left.value === null || left.value === undefined || left.value === '';
      const rightMissing = right.value === null || right.value === undefined || right.value === '';
      if (leftMissing) return rightMissing ? left.index - right.index : 1;
      if (rightMissing) return -1;
      if (typeof left.value === 'number' && typeof right.value === 'number') {
        return (left.value - right.value) * factor || left.index - right.index;
      }
      return String(left.value).localeCompare(String(right.value)) * factor || left.index - right.index;
    })
    .map(({ record }) => record);
}

export function sortRecords<K extends keyof DefectRecord>(
  records: readonly DefectRecord[],
  key: K,
  direction: SortDirection = 'asc',
): DefectRecord[] {
  const factor = direction === 'asc' ? 1 : -1;
  return [...records].sort((left, right) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue === null || leftValue === undefined) return rightValue == null ? 0 : -1 * factor;
    if (rightValue === null || rightValue === undefined) return 1 * factor;
    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      return (leftValue - rightValue) * factor;
    }
    return String(leftValue).localeCompare(String(rightValue)) * factor;
  });
}
