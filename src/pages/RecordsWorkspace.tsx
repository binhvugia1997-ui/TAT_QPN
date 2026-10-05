import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { applyRecordFilters, createEmptyFilters, parseRecordFilters, sortRecordsByValue, toggleColumnSort, writeRecordFilters, type ColumnSortState, type RecordFilters } from '../business/filters/filters';
import { getTatDaysRemaining, getTatDueDate, sortRecordsByOperationalPriority } from '../business/tat/tat';
import { matchesTatMonitoringFilter, type TatMonitoringFilter } from '../business/tat/dashboard';
import { getCorrectiveActionRecords, summarizeCorrectiveActions, type CorrectiveActionScope } from '../business/corrective/corrective';
import { getRejectedRecords } from '../business/rejected/rejected';
import { isCompletedStatus, isRejectedStatus } from '../business/status/status';
import { isDateOnly, todayDateOnly } from '../utils/date';
import type { DefectRecord, RecordId } from '../models/defect-record';
import type { Locale, MessageKey } from '../i18n';
import { translate } from '../i18n';
import RecordDetailDrawer from '../components/RecordDetailDrawer';
import TnpImportDialog from '../components/TnpImportDialog';
import RecordFiltersPanel from '../components/RecordFiltersPanel';

export type RecordsWorkspaceMode = 'records' | 'corrective' | 'rejected';
type WorkView = 'active' | 'all' | 'completed';
type TatFilter = TatMonitoringFilter;
type SortableColumn = 'tat' | 'mgmtNo' | 'registeredDate' | 'plant' | 'status' | 'deadline';
type TableColumnKey = SortableColumn | 'model' | 'defect' | 'pic' | 'caLink';
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

const TABLE_COLUMNS: Array<{ key: TableColumnKey; label: MessageKey; sortable?: SortableColumn; correctiveOnly?: boolean }> = [
  { key: 'tat', label: 'tatColumn', sortable: 'tat' },
  { key: 'mgmtNo', label: 'managementNumber', sortable: 'mgmtNo' },
  { key: 'registeredDate', label: 'dateColumn', sortable: 'registeredDate' },
  { key: 'plant', label: 'plantColumn', sortable: 'plant' },
  { key: 'model', label: 'modelColumn' },
  { key: 'defect', label: 'defectColumn' },
  { key: 'status', label: 'statusColumn', sortable: 'status' },
  { key: 'pic', label: 'picColumn' },
  { key: 'caLink', label: 'caLinkColumn', correctiveOnly: true },
  { key: 'deadline', label: 'deadlineColumn', sortable: 'deadline' },
];

function displayDate(value: string | null | undefined, locale: Locale): string {
  if (!value || !isDateOnly(value)) return '—';
  const languageTag = locale === 'vi' ? 'vi-VN' : locale === 'ko' ? 'ko-KR' : 'en-GB';
  return new Intl.DateTimeFormat(languageTag, { day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(`${value}T00:00:00`));
}

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

function sortValue(record: DefectRecord, column: SortableColumn, today: string): unknown {
  switch (column) {
    case 'tat': return getTatDaysRemaining(record, today);
    case 'mgmtNo': return record.mgmtNo;
    case 'registeredDate': return record.registeredDate;
    case 'plant': return record.plant;
    case 'status': return record.status;
    case 'deadline': return getTatDueDate(record);
  }
}

function tatLabel(record: DefectRecord, today: string, locale: Locale): { label: string; tone: string; fallback: boolean } {
  if (isCompletedStatus(record.status)) {
    return { label: translate(locale, 'completed'), tone: 'tat-completed', fallback: false };
  }
  const deadline = getTatDueDate(record);
  const remaining = getTatDaysRemaining(record, today);
  const fallback = Boolean(deadline && (!record.dueDate || !isDateOnly(record.dueDate)));
  if (remaining === null) return { label: translate(locale, 'noDeadlineValue'), tone: 'tat-undated', fallback: false };
  if (remaining < 0) return { label: translate(locale, 'tatDaysShort', { days: remaining }), tone: 'tat-overdue', fallback };
  if (remaining === 0) return { label: translate(locale, 'tatTodayShort'), tone: 'tat-today', fallback };
  if (remaining <= 3) return { label: translate(locale, 'tatDaysShort', { days: remaining }), tone: 'tat-soon', fallback };
  return { label: translate(locale, 'tatDaysShort', { days: remaining }), tone: 'tat-on-track', fallback };
}

function statusTone(status: string): string {
  if (isRejectedStatus(status)) return 'status-rejected';
  if (isCompletedStatus(status)) return 'status-completed';
  if (status === 'Đợi đối sách') return 'status-active';
  return 'status-unknown';
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
  const tableColumns = TABLE_COLUMNS.filter(({ correctiveOnly }) => !correctiveOnly || mode === 'corrective');

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
                column: translate(locale, TABLE_COLUMNS.find(({ sortable }) => sortable === manualSort.column)!.label),
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
            <table className="records-table">
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
                {visibleRecords.map((record, index) => {
                  const insertCompletedDivider = view === 'all' && completedStart === index && completedRecords.length > 0;
                  const tat = tatLabel(record, today, locale);
                  const effectiveDeadline = getTatDueDate(record);
                  const hasCaLink = Boolean(record.caFileLink?.trim());
                  return (
                    <Fragment key={`${typeof record.id}:${String(record.id)}`}>
                      {insertCompletedDivider && (
                        <tr className="completed-divider-row"><td colSpan={tableColumns.length}>{translate(locale, 'completedView')} · {completedRecords.length}</td></tr>
                      )}
                      <tr
                        className={`record-row${isCompletedStatus(record.status) ? ' completed-record-row' : ''}`}
                        onClick={() => setSelectedId(record.id)}
                      >
                        <td><span className={`tat-pill ${tat.tone}`}>{tat.label}</span></td>
                        <td className="management-cell">
                          <button type="button" className="management-link-button" aria-label={`${translate(locale, 'openDetail')}: ${record.mgmtNo}`} onClick={(event) => {
                            event.stopPropagation();
                            setSelectedId(record.id);
                          }}>
                            {record.mgmtNo || `#${String(record.id)}`}
                          </button>
                        </td>
                        <td className="date-cell">{displayDate(record.registeredDate, locale)}</td>
                        <td className="plant-cell">{record.plant || '—'}</td>
                        <td className="model-cell">{record.model || record.project || '—'}</td>
                        <td className="defect-cell" title={record.title || record.defectDetails || ''}>
                          <strong>{record.title || record.defectDetails || record.partName || translate(locale, 'untitled')}</strong>
                          {record.partCode && <small>{record.partCode}</small>}
                        </td>
                        <td><span className={`status-pill ${statusTone(record.status)}`}>{record.status || '—'}</span></td>
                        <td className="pic-cell">{record.pic || <span className="unassigned-value">—</span>}</td>
                        {mode === 'corrective' && (
                          <td className="ca-link-cell" title={hasCaLink ? record.caFileLink ?? undefined : undefined}>
                            <span className={hasCaLink ? 'ca-link-state attached' : 'ca-link-state missing'}>
                              {translate(locale, hasCaLink ? 'caLinked' : 'missingCaLink')}
                            </span>
                          </td>
                        )}
                        <td className="date-cell deadline-cell">
                          {displayDate(effectiveDeadline, locale)}
                          {effectiveDeadline && <small>{translate(locale, tat.fallback ? 'fallbackDeadline' : 'sourceDeadline')}</small>}
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
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
