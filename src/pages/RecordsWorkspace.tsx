import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { applyRecordFilters, createEmptyFilters, parseRecordFilters, sortRecordsByValue, toggleColumnSort, writeRecordFilters, type ColumnSortState, type RecordFilters } from '../business/filters/filters';
import { getTatDaysRemaining, sortRecordsByOperationalPriority } from '../business/tat/tat';
import { matchesTatMonitoringFilter, type TatMonitoringFilter } from '../business/tat/dashboard';
import { getCorrectiveActionRecords, summarizeCorrectiveActions, type CorrectiveActionScope } from '../business/corrective/corrective';
import { getRejectedRecords } from '../business/rejected/rejected';
import { isCompletedStatus } from '../business/status/status';
import {
  createReportIndex,
  getRecordCellSource,
  getVisibleRecordsColumns,
  type RecordsTableSortableColumn,
  type ReportIndex,
} from '../business/records/recordsTable';
import { todayDateOnly } from '../utils/date';
import type { DefectRecord, RecordId } from '../models/defect-record';
import type { Locale, MessageKey } from '../i18n';
import { translate } from '../i18n';
import { serverApi } from '../services/server/serverRecordRepository';
import RecordDetailDrawer from '../components/RecordDetailDrawer';
import RecordsTableRow from '../components/RecordsTableRow';
import TnpImportDialog from '../components/TnpImportDialog';
import RecordFiltersPanel from '../components/RecordFiltersPanel';

export type RecordsWorkspaceMode = 'records' | 'corrective' | 'rejected';
type WorkView = 'active' | 'all' | 'completed';
type TatFilter = TatMonitoringFilter;
type SortableColumn = RecordsTableSortableColumn;
type ManualSort = ColumnSortState<SortableColumn>;

interface RecordsWorkspaceProps {
  locale: Locale;
  records: readonly DefectRecord[];
  mode: RecordsWorkspaceMode;
  onRecordsChanged: () => Promise<void>;
}

const TAT_FILTERS: Array<{ value: TatFilter; label: MessageKey }> = [
  { value: 'all', label: 'tatAll' },
  { value: 'overdue', label: 'tatOverdue' },
  { value: 'due-today', label: 'tatToday' },
  { value: 'one-day', label: 'tatDueInOne' },
  { value: 'two-days', label: 'tatDueInTwo' },
  { value: 'later', label: 'tatDueLater' },
  { value: 'due-soon', label: 'tatDueSoon' },
  { value: 'on-track', label: 'tatOnTrack' },
  { value: 'no-deadline', label: 'tatNoDeadline' },
];

function pageTitle(mode: RecordsWorkspaceMode): MessageKey {
  if (mode === 'corrective') return 'corrective';
  if (mode === 'rejected') return 'rejected';
  return 'records';
}

function pageDescription(mode: RecordsWorkspaceMode): MessageKey {
  if (mode === 'corrective') return 'correctiveDescription';
  if (mode === 'rejected') return 'rejectedDescription';
  return 'recordsDescription';
}

/** Sorting reads the same raw source value the cell renders, so order always matches display. */
function sortValue(record: DefectRecord, column: SortableColumn, today: string): unknown {
  return getRecordCellSource(record, column, today);
}

export default function RecordsWorkspace({ locale, records, mode, onRecordsChanged }: RecordsWorkspaceProps) {
  const today = todayDateOnly();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<RecordFilters>(() => createEmptyFilters());
  const [view, setView] = useState<WorkView>('active');
  const [manualSort, setManualSort] = useState<ManualSort | null>(null);
  const [tatFilter, setTatFilter] = useState<TatFilter>('all');
  const [correctiveScope, setCorrectiveScope] = useState<CorrectiveActionScope>('all');
  const [selectedId, setSelectedId] = useState<RecordId | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [reportIndex, setReportIndex] = useState<ReportIndex>(() => new Map());

  /**
   * The QPN column links straight to a record's managed report, so the bulk index is
   * refetched whenever the record set changes: importing, editing, or attaching/unlinking
   * in the detail drawer all refresh `records`. A failed lookup only clears the links —
   * it must never hide the records themselves.
   */
  useEffect(() => {
    let active = true;
    serverApi.reportIndex().then(
      (entries) => {
        if (active) setReportIndex(createReportIndex(entries));
      },
      () => {
        if (active) setReportIndex(new Map());
      },
    );
    return () => {
      active = false;
    };
  }, [records]);

  useEffect(() => {
    const nextFilters = parseRecordFilters(searchParams);
    const requestedView = searchParams.get('view');
    setView(mode === 'corrective' || mode === 'rejected'
      ? 'active'
      : requestedView === 'all' || requestedView === 'completed' ? requestedView : 'active');
    const requestedTat = searchParams.get('tat') as TatFilter | null;
    setTatFilter(TAT_FILTERS.some(({ value }) => value === requestedTat) ? requestedTat! : 'all');
    const requestedCorrectiveScope = searchParams.get('followUp') as CorrectiveActionScope | null;
    setCorrectiveScope(requestedCorrectiveScope === 'unassigned' || requestedCorrectiveScope === 'missing-ca-link'
      ? requestedCorrectiveScope
      : 'all');
    setFilters(nextFilters);
    if (searchParams.get('import') === '1') {
      setImportOpen(true);
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('import');
      setSearchParams(nextParams, { replace: true });
    }
  }, [mode, searchParams, setSearchParams]);

  const scopedRecords = useMemo(() => {
    if (mode === 'rejected') return getRejectedRecords(records, today);
    if (mode === 'corrective') return records.filter((record) => !isCompletedStatus(record.status));
    return records;
  }, [mode, records, today]);
  const filteredByFields = useMemo(() => applyRecordFilters(scopedRecords, filters), [scopedRecords, filters]);
  const filteredRecords = useMemo(() => filteredByFields
    .filter((record) => matchesTatMonitoringFilter(record, tatFilter, today)), [filteredByFields, tatFilter, today]);
  const viewRecords = useMemo(() => mode === 'corrective'
    ? getCorrectiveActionRecords(filteredRecords, today, correctiveScope)
    : filteredRecords, [mode, filteredRecords, today, correctiveScope]);
  const correctiveSummary = useMemo(() => mode === 'corrective'
    ? summarizeCorrectiveActions(filteredByFields, today)
    : null, [mode, filteredByFields, today]);
  const rejectedSummary = useMemo(() => mode === 'rejected' ? {
    total: filteredByFields.length,
    overdue: filteredByFields.filter((record) => (getTatDaysRemaining(record, today) ?? 0) < 0).length,
    dueToday: filteredByFields.filter((record) => getTatDaysRemaining(record, today) === 0).length,
  } : null, [mode, filteredByFields, today]);

  const sortedQueue = useMemo(() => {
    if (!manualSort) return sortRecordsByOperationalPriority(viewRecords, today);
    const active = viewRecords.filter((record) => !isCompletedStatus(record.status));
    const completed = viewRecords.filter((record) => isCompletedStatus(record.status));
    const valueOf = (record: DefectRecord) => sortValue(record, manualSort.column, today);
    return [
      ...sortRecordsByValue(active, valueOf, manualSort.direction),
      ...sortRecordsByValue(completed, valueOf, manualSort.direction),
    ];
  }, [viewRecords, manualSort, today]);
  const activeRecords = sortedQueue.filter((record) => !isCompletedStatus(record.status));
  const completedRecords = sortedQueue.filter((record) => isCompletedStatus(record.status));
  const visibleRecords = view === 'active'
    ? activeRecords
    : view === 'completed'
      ? completedRecords
      : sortedQueue;
  const completedStart = view === 'all' ? activeRecords.length : -1;
  const selectedRecord = selectedId === null ? undefined : records.find((record) => record.id === selectedId);

  const handleViewChange = (nextView: WorkView) => {
    setView(nextView);
    const nextParams = new URLSearchParams(searchParams);
    if (nextView === 'active') nextParams.delete('view');
    else nextParams.set('view', nextView);
    setSearchParams(nextParams, { replace: true });
  };

  const handleFiltersChange = (nextFilters: RecordFilters) => {
    setFilters(nextFilters);
    setSearchParams(writeRecordFilters(searchParams, nextFilters), { replace: true });
  };

  const handleTatFilterChange = (nextFilter: TatFilter) => {
    setTatFilter(nextFilter);
    const nextParams = new URLSearchParams(searchParams);
    if (nextFilter === 'all') nextParams.delete('tat');
    else nextParams.set('tat', nextFilter);
    setSearchParams(nextParams, { replace: true });
  };

  const setCorrectiveFilter = (scope: CorrectiveActionScope) => {
    setCorrectiveScope(scope);
    const nextParams = new URLSearchParams(searchParams);
    if (scope === 'all') nextParams.delete('followUp');
    else nextParams.set('followUp', scope);
    setSearchParams(nextParams, { replace: true });
  };

  const clearFilters = () => {
    setFilters(createEmptyFilters());
    setManualSort(null);
    setTatFilter('all');
    setCorrectiveScope('all');
    setView('active');
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  const extraFilterTags = tatFilter !== 'all'
    ? [`${translate(locale, 'tatFilter')}: ${translate(locale, TAT_FILTERS.find(({ value }) => value === tatFilter)!.label)}`]
    : [];
  const tableColumns = getVisibleRecordsColumns({ corrective: mode === 'corrective' });

  return (
    <div className="page records-page">
      <header className="workspace-heading">
        <div>
          <h2>{translate(locale, pageTitle(mode))}</h2>
          <p>{translate(locale, pageDescription(mode))}</p>
        </div>
        <div className="workspace-actions">
          <span className="records-count">{translate(locale, 'rowsShown', { shown: visibleRecords.length, total: scopedRecords.length })}</span>
          <button type="button" className="primary-button" onClick={() => setImportOpen(true)}>
            <span aria-hidden="true">＋</span> {translate(locale, 'addTnpFile')}
          </button>
        </div>
      </header>

      {mode === 'rejected' && rejectedSummary && (
        <section className="rejected-summary-strip" aria-label={translate(locale, 'rejectedSummary')}>
          <div><span>{translate(locale, 'rejectedMetric')}</span><strong>{rejectedSummary.total}</strong></div>
          <button type="button" aria-pressed={tatFilter === 'overdue'} onClick={() => handleTatFilterChange(tatFilter === 'overdue' ? 'all' : 'overdue')}>
            <span>{translate(locale, 'overdue')}</span><strong>{rejectedSummary.overdue}</strong>
          </button>
          <button type="button" aria-pressed={tatFilter === 'due-today'} onClick={() => handleTatFilterChange(tatFilter === 'due-today' ? 'all' : 'due-today')}>
            <span>{translate(locale, 'dueToday')}</span><strong>{rejectedSummary.dueToday}</strong>
          </button>
        </section>
      )}

      {mode === 'corrective' && correctiveSummary && (
        <section className="corrective-summary-strip" aria-label={translate(locale, 'correctiveSummary')}>
          <button type="button" className={correctiveScope === 'all' ? 'corrective-scope selected' : 'corrective-scope'} aria-pressed={correctiveScope === 'all'} onClick={() => setCorrectiveFilter('all')}>
            <span>{translate(locale, 'allFollowUp')}</span><strong>{correctiveSummary.actionable}</strong>
          </button>
          <button type="button" className={correctiveScope === 'unassigned' ? 'corrective-scope selected' : 'corrective-scope'} aria-pressed={correctiveScope === 'unassigned'} onClick={() => setCorrectiveFilter('unassigned')}>
            <span>{translate(locale, 'needsPic')}</span><strong>{correctiveSummary.unassigned}</strong>
          </button>
          <button type="button" className={correctiveScope === 'missing-ca-link' ? 'corrective-scope selected' : 'corrective-scope'} aria-pressed={correctiveScope === 'missing-ca-link'} onClick={() => setCorrectiveFilter('missing-ca-link')}>
            <span>{translate(locale, 'missingCaLink')}</span><strong>{correctiveSummary.missingCaLink}</strong>
          </button>
          <span className="corrective-priority-note">{translate(locale, 'correctivePriorityNote')}</span>
        </section>
      )}

      <div className="record-toolbar">
        <div className="view-switch" role="tablist" aria-label={translate(locale, 'recordWorkView')}>
          {mode === 'corrective' || mode === 'rejected' ? (
            <button type="button" role="tab" aria-selected="true" className="view-tab selected">
              {translate(locale, 'activeView')} <span>{activeRecords.length}</span>
            </button>
          ) : (
            ([
              ['active', 'activeView', activeRecords.length],
              ['all', 'allView', filteredRecords.length],
              ['completed', 'completedView', completedRecords.length],
            ] as const).map(([value, label, count]) => (
              <button
                type="button"
                role="tab"
                aria-selected={view === value}
                className={view === value ? 'view-tab selected' : 'view-tab'}
                key={value}
                onClick={() => handleViewChange(value)}
              >
                {translate(locale, label)} <span>{count}</span>
              </button>
            ))
          )}
        </div>
        <div className="record-sort-controls">
          <span className="priority-note" aria-live="polite">
            <i aria-hidden="true" />
            {manualSort
              ? translate(locale, 'sortedBy', {
                column: translate(locale, tableColumns.find(({ sortable }) => sortable === manualSort.column)!.label),
                direction: translate(locale, manualSort.direction === 'asc' ? 'sortAscending' : 'sortDescending'),
              })
              : locale === 'vi' ? 'Ưu tiên theo deadline hiệu lực' : locale === 'ko' ? '유효 기한 우선 정렬' : 'Prioritized by effective deadline'}
          </span>
          <button
            type="button"
            className="priority-reset-button"
            aria-pressed={!manualSort}
            onClick={() => setManualSort(null)}
          >
            {translate(locale, 'prioritySort')}
          </button>
        </div>
      </div>

      <RecordFiltersPanel
        locale={locale}
        records={records}
        filters={filters}
        onChange={handleFiltersChange}
        onClear={clearFilters}
        extraTags={extraFilterTags}
      >
        <label className="filter-control tat-filter-control">
          <span>{translate(locale, 'tatFilter')}</span>
          <select value={tatFilter} onChange={(event) => handleTatFilterChange(event.target.value as TatFilter)}>
            {TAT_FILTERS.map(({ value, label }) => <option key={value} value={value}>{translate(locale, label)}</option>)}
          </select>
        </label>
      </RecordFiltersPanel>

      <section className="records-table-panel" aria-label={translate(locale, 'records')}>
        {visibleRecords.length === 0 ? (
          <div className="empty-state records-empty-state">
            <strong>{translate(locale, mode === 'rejected' && scopedRecords.length === 0 ? 'noRejectedRecords' : mode === 'corrective' && scopedRecords.length === 0 ? 'noCorrectiveRecords' : 'noRecords')}</strong>
            <button type="button" className="secondary-button" onClick={clearFilters}>{translate(locale, 'clearAll')}</button>
          </div>
        ) : (
          <div className="table-scroll">
            <table className={mode === 'corrective' ? 'records-table has-ca-link' : 'records-table'}>
              <thead><tr>
                {tableColumns.map(({ key, label, sortable }) => {
                  if (!sortable) return <th key={key}>{translate(locale, label)}</th>;
                  const active = manualSort?.column === sortable;
                  const direction = active ? manualSort.direction : null;
                  const ariaSort = direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none';
                  const nextDirection = direction === 'asc' ? 'sortDescending' : 'sortAscending';
                  return (
                    <th key={key} aria-sort={ariaSort}>
                      <button
                        type="button"
                        className="table-sort-button"
                        aria-label={`${translate(locale, label)}: ${translate(locale, nextDirection)}`}
                        aria-pressed={active}
                        onClick={() => setManualSort((current) => toggleColumnSort(current, sortable))}
                      >
                        <span>{translate(locale, label)}</span>
                        <span className="table-sort-indicator" aria-hidden="true">{direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : '↕'}</span>
                      </button>
                    </th>
                  );
                })}
              </tr></thead>
              <tbody>
                {visibleRecords.map((record, index) => (
                  <Fragment key={`${typeof record.id}:${String(record.id)}`}>
                    {view === 'all' && completedStart === index && completedRecords.length > 0 && (
                      <tr className="completed-divider-row"><td colSpan={tableColumns.length}>{translate(locale, 'completedView')} · {completedRecords.length}</td></tr>
                    )}
                    <RecordsTableRow
                      locale={locale}
                      record={record}
                      sequence={index + 1}
                      today={today}
                      reportIndex={reportIndex}
                      showCaLink={mode === 'corrective'}
                      onSelect={(selected) => setSelectedId(selected.id)}
                    />
                  </Fragment>
                ))}
                {view === 'all' && completedStart === visibleRecords.length && completedRecords.length > 0 && (
                  <tr className="completed-divider-row"><td colSpan={tableColumns.length}>{translate(locale, 'completedView')} · {completedRecords.length}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedRecord && (
        <RecordDetailDrawer
          locale={locale}
          record={selectedRecord}
          onClose={() => setSelectedId(null)}
          onSaved={onRecordsChanged}
        />
      )}
      {importOpen && (
        <TnpImportDialog
          locale={locale}
          onClose={() => setImportOpen(false)}
          onImported={onRecordsChanged}
        />
      )}
    </div>
  );
}
