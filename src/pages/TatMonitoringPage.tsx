import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { applyRecordFilters, buildRecordsHref, createEmptyFilters, EMPTY_FILTER_QUERY_VALUE, type RecordFilters } from '../business/filters/filters';
import { calculateTatDashboard, type TatDashboardBucket } from '../business/tat/dashboard';
import RecordFiltersPanel from '../components/RecordFiltersPanel';
import type { DefectRecord } from '../models/defect-record';
import type { Locale } from '../i18n';
import { translate } from '../i18n';
import { todayDateOnly } from '../utils/date';

interface TatMonitoringPageProps {
  locale: Locale;
  records: readonly DefectRecord[];
}

function displayPlant(locale: Locale, plant: string): string {
  return plant === 'Not analyzed' ? translate(locale, 'notAnalyzed') : plant;
}

export default function TatMonitoringPage({ locale, records }: TatMonitoringPageProps) {
  const navigate = useNavigate();
  const today = todayDateOnly();
  const [filters, setFilters] = useState<RecordFilters>(() => createEmptyFilters());
  const filteredRecords = useMemo(() => applyRecordFilters(records, filters), [records, filters]);
  const dashboard = useMemo(() => calculateTatDashboard(filteredRecords, today), [filteredRecords, today]);
  const metrics: Array<{ bucket: TatDashboardBucket; label: string; count: number; tone: string }> = [
    { bucket: 'overdue', label: translate(locale, 'overdue'), count: dashboard.buckets.overdue, tone: 'tat-metric-overdue' },
    { bucket: 'due-today', label: translate(locale, 'dueToday'), count: dashboard.buckets['due-today'], tone: 'tat-metric-today' },
    { bucket: 'one-day', label: translate(locale, 'tatDueInOne'), count: dashboard.buckets['one-day'], tone: 'tat-metric-soon' },
    { bucket: 'two-days', label: translate(locale, 'tatDueInTwo'), count: dashboard.buckets['two-days'], tone: 'tat-metric-soon' },
    { bucket: 'later', label: translate(locale, 'tatDueLater'), count: dashboard.buckets.later, tone: 'tat-metric-later' },
  ];

  const drillDown = (bucket: TatDashboardBucket, plant?: string) => navigate(buildRecordsHref(filters, {
    view: 'active',
    tat: bucket,
    ...(plant === undefined ? {} : { plant: plant || EMPTY_FILTER_QUERY_VALUE }),
  }));

  return (
    <div className="page dashboard-page tat-dashboard-page">
      <header className="workspace-heading dashboard-heading">
        <div>
          <h2>{translate(locale, 'tatMonitoringTitle')}</h2>
          <p>{translate(locale, 'tatMonitoringDescription')}</p>
        </div>
        <span className="records-count">{translate(locale, 'tatTrackedCount', { tracked: dashboard.tracked, active: dashboard.active })}</span>
      </header>

      <RecordFiltersPanel
        locale={locale}
        records={records}
        filters={filters}
        onChange={setFilters}
        onClear={() => setFilters(createEmptyFilters())}
      />

      {filteredRecords.length === 0 ? (
        <div className="dashboard-empty dashboard-empty-wide">{translate(locale, 'noDashboardRecords')}</div>
      ) : (
        <>
          <section className="tat-bucket-grid" aria-label={translate(locale, 'tatBucketSummary')}>
            {metrics.map(({ bucket, label, count, tone }) => (
              <button type="button" className={`tat-bucket-card ${tone}`} key={bucket} onClick={() => drillDown(bucket)}>
                <span>{label}</span>
                <strong>{count.toLocaleString()}</strong>
                <small>{translate(locale, 'openMatchingRecords')}</small>
              </button>
            ))}
            <button type="button" className="tat-bucket-card tat-metric-untracked" onClick={() => drillDown('no-deadline')}>
              <span>{translate(locale, 'noDeadlineValue')}</span>
              <strong>{dashboard.buckets['no-deadline'].toLocaleString()}</strong>
              <small>{translate(locale, 'openMatchingRecords')}</small>
            </button>
          </section>

          <section className="analysis-panel tat-breakdown-panel">
            <div className="analysis-panel-heading">
              <div><h3>{translate(locale, 'overdueByPlant')}</h3><p>{translate(locale, 'tatBreakdownHint')}</p></div>
              <span>{dashboard.buckets.overdue} {translate(locale, 'overdue')}</span>
            </div>
            {dashboard.overdueByPlant.length === 0 ? (
              <div className="dashboard-empty chart-empty">{translate(locale, 'noOverdueRecords')}</div>
            ) : (
              <div className="analysis-bar-list tat-plant-list">
                {dashboard.overdueByPlant.map(({ plant, filterValue, count }) => (
                  <button
                    type="button"
                    className="analysis-bar-row"
                    key={plant}
                    onClick={() => drillDown('overdue', filterValue)}
                  >
                    <span className="analysis-bar-label">{displayPlant(locale, plant)}</span>
                    <span className="analysis-bar-track"><span style={{ width: `${Math.max(3, (count / dashboard.buckets.overdue) * 100)}%` }} /></span>
                    <strong>{count}</strong>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
