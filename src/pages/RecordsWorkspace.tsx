import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  RECORDS_TABLE_COLUMNS,
  MANUAL_CONDITION_FIELD,
  MANUAL_DEFECT_NAME_FIELD,
  type ManualInlineField,
  type RecordsTableSortableColumn,
  type ReportIndex,
} from '../business/records/recordsTable';
import {
  applyColumnVisibility,
  SELECTABLE_RECORDS_COLUMNS,
  totalColumnWidth,
} from '../business/records/columnVisibility';
import {
  applyColumnWidths,
  computeColumnLayout,
  defaultColumnWidths,
  measureScrollWidth,
  resetColumnWidth,
  type ColumnWidths,
} from '../business/records/columnWidths';
import type { RecordsTableColumn, RecordsTableColumnKey } from '../business/records/recordsTable';
import { loadVisibleColumns, saveVisibleColumns } from '../services/preferences/columnPreferences';
import {
  clearColumnWidths,
  loadColumnWidths,
  saveColumnWidths,
} from '../services/preferences/columnWidthPreferences';
import { RESET_COLUMN_WIDTH_SENTINEL } from '../components/ColumnResizeHandle';
import { todayDateOnly } from '../utils/date';
import type { DefectRecord, RecordId } from '../models/defect-record';
import type { Locale, MessageKey } from '../i18n';
import { translate } from '../i18n';
import { serverApi } from '../services/server/serverRecordRepository';
import { recordService } from '../app/services';
import ColumnsMenu from '../components/ColumnsMenu';
import ColumnResizeHandle from '../components/ColumnResizeHandle';
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

/**
 * The width preference is keyed against every column the table can render — including the
 * corrective-only CA badge — so a manual width survives hiding and re-showing a column, and an
 * unknown key in stored data is dropped rather than trusted.
 */
const REQUIRED_RECORDS_COLUMNS_FOR_WIDTHS: readonly RecordsTableColumn[] = RECORDS_TABLE_COLUMNS;

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
  // Per-client display preference, restored from this browser's own storage. Never stored
  // in SQLite, so it cannot affect record data, imports or any other client.
  const [visibleColumns, setVisibleColumns] = useState<ReadonlySet<RecordsTableColumnKey>>(
    () => loadVisibleColumns(),
  );

  const handleVisibleColumnsChange = useCallback((next: ReadonlySet<RecordsTableColumnKey>) => {
    setVisibleColumns(next);
    saveVisibleColumns(next);
  }, []);

  /**
   * Manual column widths — also per-client display state, in its own localStorage key so a
   * damaged width preference cannot affect which columns are shown, and vice versa.
   */
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(
    () => loadColumnWidths(defaultColumnWidths(REQUIRED_RECORDS_COLUMNS_FOR_WIDTHS)),
  );

  /** Usable width of the scroll container, for the responsive (stretch) layout. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const read = () => setAvailableWidth(measureScrollWidth(element.clientWidth, element.scrollWidth));
    read();
    // Older hosts have no ResizeObserver; the table then keeps its natural sizing, which is
    // exactly the pre-existing behaviour rather than a broken layout.
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * Persists the width preference only when a gesture ends. Writing per pointer-move would hit
   * localStorage thousands of times per drag for no visual benefit.
   */
  const persistWidths = useCallback((next: ColumnWidths) => {
    saveColumnWidths(next, defaultColumnWidths(REQUIRED_RECORDS_COLUMNS_FOR_WIDTHS));
  }, []);

  const handleColumnResize = useCallback((key: RecordsTableColumnKey, nextWidth: number) => {
    setColumnWidths((current) => {
      if (nextWidth === RESET_COLUMN_WIDTH_SENTINEL) {
        const cleared = resetColumnWidth(current, key);
        persistWidths(cleared);
        return cleared;
      }
      const updated = { ...current, [key]: nextWidth };
      persistWidths(updated);
      return updated;
    });
  }, [persistWidths]);

  const handleResetColumnWidths = useCallback(() => {
    setColumnWidths({});
    clearColumnWidths();
  }, []);

  /** Refetches the bulk report index; also used after an inline QPN attachment change. */
  const reloadReportIndex = useCallback(async () => {
    try {
      setReportIndex(createReportIndex(await serverApi.reportIndex()));
    } catch {
      // A failed lookup only clears the links; it must never hide the records themselves.
      setReportIndex(new Map());
    }
  }, []);

  /**
   * Inline edit of an app-managed manual field ("Tên lỗi" and "Tình trạng"). Goes through the
   * same record update path as the Detail drawer, so the write gets the server's
   * optimistic-concurrency check and its audit trail rather than a second persistence route.
   * Only the one manual field is patched: the imported `defectDetails` and the canonical
   * `status` are left exactly as they were.
   */
  const saveManualField = useCallback(async (
    record: DefectRecord,
    field: ManualInlineField,
    next: string,
  ) => {
    await recordService.updateRecord(record.id, { [field]: next || null });
    await onRecordsChanged();
  }, [onRecordsChanged]);

  const saveDefectName = useCallback(
    (record: DefectRecord, next: string) => saveManualField(record, MANUAL_DEFECT_NAME_FIELD, next),
    [saveManualField],
  );
  const saveCondition = useCallback(
    (record: DefectRecord, next: string) => saveManualField(record, MANUAL_CONDITION_FIELD, next),
    [saveManualField],
  );

  /**
   * The QPN column links straight to a record's managed report, so the bulk index is
   * refetched whenever the record set changes: importing, editing, or attaching/unlinking
   * in the detail drawer all refresh `records`.
   */
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const entries = await serverApi.reportIndex();
        if (active) setReportIndex(createReportIndex(entries));
      } catch {
        if (active) setReportIndex(new Map());
      }
    })();
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
  /** Columns actually rendered: the mode's columns, minus whichever the user hid. */
  const specColumns = useMemo(() => applyColumnVisibility(
    getVisibleRecordsColumns({ corrective: mode === 'corrective' }),
    visibleColumns,
  ), [mode, visibleColumns]);
  /** Manual widths are applied last, so a hidden column keeps its width for when it returns. */
  const tableColumns = useMemo(
    () => applyColumnWidths(specColumns, columnWidths),
    [specColumns, columnWidths],
  );
  const columnKeys = useMemo(() => tableColumns.map(({ key }) => key), [tableColumns]);
  /** Kept as the fallback when the container cannot be measured (first paint, no observer). */
  const naturalTableWidth = totalColumnWidth(tableColumns);
  const tableLayout = useMemo(
    () => computeColumnLayout({ columns: tableColumns, availableWidth }),
    [tableColumns, availableWidth],
  );
  const tableMinWidth = tableLayout.minWidth || naturalTableWidth;

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
        <ColumnsMenu
          locale={locale}
          columns={SELECTABLE_RECORDS_COLUMNS}
          visible={visibleColumns}
          onChange={handleVisibleColumnsChange}
          // Resizing is offered from the same popover that controls visibility, so one control
          // owns the table layout; widths are restored for every column at once.
          onResetWidths={handleResetColumnWidths}
        />
      </RecordFiltersPanel>

      <section className="records-table-panel" aria-label={translate(locale, 'records')}>
        {visibleRecords.length === 0 ? (
          <div className="empty-state records-empty-state">
            <strong>{translate(locale, mode === 'rejected' && scopedRecords.length === 0 ? 'noRejectedRecords' : mode === 'corrective' && scopedRecords.length === 0 ? 'noCorrectiveRecords' : 'noRecords')}</strong>
            <button type="button" className="secondary-button" onClick={clearFilters}>{translate(locale, 'clearAll')}</button>
          </div>
        ) : (
          // The ref is the measurement source for the responsive layout: the table stretches its
          // columns in proportion when the window is wide enough and scrolls below the natural
          // width, which is what keeps all fourteen approved columns readable.
          <div className="table-scroll" ref={scrollRef}>
            <table
              className="records-table records-table-responsive"
              style={{ minWidth: `${tableMinWidth}px` }}
            >
              {/*
                Percentages, not px: under `table-layout: fixed` a px `<col>` total smaller than
                the table leaves dead space and ignores the window. Percent widths always fill,
                `min-width` above preserves each column's real floor, and hiding a column hands its
                share to the rest. Widths come from the visible set, so the mapping cannot drift.
              */}
              <colgroup>
                {tableColumns.map(({ key }) => (
                  <col key={key} style={{ width: `${tableLayout.percentages[key] ?? 0}%` }} />
                ))}
              </colgroup>
              <thead><tr>
                {tableColumns.map(({ key, label, sortable, width }) => {
                  const headerLabel = translate(locale, label);
                  const resize = (
                    <ColumnResizeHandle
                      locale={locale}
                      columnLabel={headerLabel}
                      width={width}
                      onResize={(nextWidth) => handleColumnResize(key, nextWidth)}
                      onResizeEnd={(nextWidth) => handleColumnResize(key, nextWidth)}
                    />
                  );
                  if (!sortable) {
                    return <th key={key} className="resizable-header">{headerLabel}{resize}</th>;
                  }
                  const active = manualSort?.column === sortable;
                  const direction = active ? manualSort.direction : null;
                  const ariaSort = direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none';
                  const nextDirection = direction === 'asc' ? 'sortDescending' : 'sortAscending';
                  return (
                    <th key={key} className="resizable-header" aria-sort={ariaSort}>
                      <button
                        type="button"
                        className="table-sort-button"
                        aria-label={`${headerLabel}: ${translate(locale, nextDirection)}`}
                        aria-pressed={active}
                        onClick={() => setManualSort((current) => toggleColumnSort(current, sortable))}
                      >
                        <span>{headerLabel}</span>
                        <span className="table-sort-indicator" aria-hidden="true">{direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : '↕'}</span>
                      </button>
                      {resize}
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
                      columns={columnKeys}
                      onSelect={(selected) => setSelectedId(selected.id)}
                      onSaveDefectName={saveDefectName}
                      onSaveCondition={saveCondition}
                      onReportChanged={() => {
                        void reloadReportIndex();
                      }}
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
