import type { ReactNode } from 'react';
import { getFilterOptions, EMPTY_FILTER_QUERY_VALUE, type RecordFilterKey, type RecordFilters } from '../business/filters/filters';
import type { DefectRecord } from '../models/defect-record';
import type { Locale, MessageKey } from '../i18n';
import { translate } from '../i18n';

interface RecordFiltersPanelProps {
  locale: Locale;
  records: readonly DefectRecord[];
  filters: RecordFilters;
  onChange: (filters: RecordFilters) => void;
  onClear: () => void;
  extraTags?: readonly string[];
  children?: ReactNode;
}

const MORE_FILTERS: Array<{
  key: RecordFilterKey;
  label: MessageKey;
  valuesKey: keyof ReturnType<typeof getFilterOptions>;
}> = [
  { key: 'project', label: 'projectFilter', valuesKey: 'project' },
  { key: 'model', label: 'modelFilter', valuesKey: 'model' },
  { key: 'partGroup', label: 'partGroupFilter', valuesKey: 'partGroup' },
  { key: 'occurPlace', label: 'occurPlaceFilter', valuesKey: 'occurPlace' },
  { key: 'reason1', label: 'reasonFilter', valuesKey: 'reason1' },
  { key: 'defectCode', label: 'defectCodeFilter', valuesKey: 'defectCode' },
  { key: 'month', label: 'monthFilter', valuesKey: 'month' },
];

function isMissing(record: DefectRecord, key: RecordFilterKey): boolean {
  const field = key === 'defectCode' ? 'partCode' : key === 'month' ? 'registeredDate' : key;
  const value = (record as Record<string, unknown>)[field];
  return value === null || value === undefined || String(value).trim() === '';
}

function selectedValue(values: ReadonlySet<string>): string {
  const value = values.values().next().value as string | undefined;
  if (value === undefined) return '';
  return value === '' ? EMPTY_FILTER_QUERY_VALUE : value;
}

export default function RecordFiltersPanel({ locale, records, filters, onChange, onClear, extraTags = [], children }: RecordFiltersPanelProps) {
  const options = getFilterOptions(records);
  const updateFacet = (key: RecordFilterKey, rawValue: string) => {
    const value = rawValue === EMPTY_FILTER_QUERY_VALUE ? '' : rawValue;
    onChange({ ...filters, [key]: value ? new Set([value]) : new Set<string>() });
  };

  const facetSelect = (key: RecordFilterKey, label: MessageKey, valuesKey: keyof typeof options) => (
    <label className="filter-control" key={key}>
      <span>{translate(locale, label)}</span>
      <select value={selectedValue(filters[key])} onChange={(event) => updateFacet(key, event.target.value)}>
        <option value="">{translate(locale, 'allView')}</option>
        {records.some((record) => isMissing(record, key)) && (
          <option value={EMPTY_FILTER_QUERY_VALUE}>
            {translate(locale, key === 'plant' ? 'notAnalyzed' : 'notSpecified')}
          </option>
        )}
        {options[valuesKey].map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    </label>
  );

  const tags: Array<{ key: string; label: string }> = [];
  if (filters.search) tags.push({ key: 'search', label: `${translate(locale, 'searchLabel')}: ${filters.search}` });
  for (const key of ['plant', 'status', ...MORE_FILTERS.map(({ key: filterKey }) => filterKey)] as RecordFilterKey[]) {
    for (const value of filters[key]) {
      const filterLabel = key === 'plant' ? 'plantFilter'
        : key === 'status' ? 'statusFilter'
          : MORE_FILTERS.find((item) => item.key === key)!.label;
      const display = value || translate(locale, key === 'plant' ? 'notAnalyzed' : 'notSpecified');
      tags.push({ key: `${key}:${value}`, label: `${translate(locale, filterLabel)}: ${display}` });
    }
  }
  if (filters.dateFrom) tags.push({ key: 'dateFrom', label: `${translate(locale, 'dateFrom')}: ${filters.dateFrom}` });
  if (filters.dateTo) tags.push({ key: 'dateTo', label: `${translate(locale, 'dateTo')}: ${filters.dateTo}` });
  extraTags.forEach((label, index) => tags.push({ key: `extra:${index}`, label }));

  return (
    <section className="filter-panel shared-filter-panel" aria-label={translate(locale, 'recordFilters')}>
      <div className="filter-row primary-filters">
        <label className="search-control">
          <span>{translate(locale, 'searchLabel')}</span>
          <input
            type="search"
            value={filters.search}
            placeholder={translate(locale, 'searchPlaceholder')}
            onChange={(event) => onChange({ ...filters, search: event.target.value })}
          />
        </label>
        {facetSelect('plant', 'plantFilter', 'plant')}
        {facetSelect('status', 'statusFilter', 'status')}
        {children}
        <details className="more-filters">
          <summary>{translate(locale, 'moreFilters')}</summary>
          <div className="more-filter-content">
            <div className="more-filter-grid">
              {MORE_FILTERS.map(({ key, label, valuesKey }) => facetSelect(key, label, valuesKey))}
              <label className="filter-control">
                <span>{translate(locale, 'dateFrom')}</span>
                <input type="date" value={filters.dateFrom} onChange={(event) => onChange({ ...filters, dateFrom: event.target.value })} />
              </label>
              <label className="filter-control">
                <span>{translate(locale, 'dateTo')}</span>
                <input type="date" value={filters.dateTo} onChange={(event) => onChange({ ...filters, dateTo: event.target.value })} />
              </label>
            </div>
          </div>
        </details>
        <button type="button" className="clear-filters-button" onClick={onClear}>{translate(locale, 'clearAll')}</button>
      </div>
      {tags.length > 0 && (
        <div className="active-filter-row" aria-live="polite">
          <span>{translate(locale, 'activeFilters')}</span>
          {tags.map((tag) => <span className="filter-chip" key={tag.key}>{tag.label}</span>)}
          <button type="button" onClick={onClear}>{translate(locale, 'clearAll')}</button>
        </div>
      )}
    </section>
  );
}
