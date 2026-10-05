import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { calculateAnalysis, type AnalysisCategory } from '../business/analysis/analysis';
import { applyRecordFilters, buildRecordsHref, createEmptyFilters, EMPTY_FILTER_QUERY_VALUE, type RecordFilters } from '../business/filters/filters';
import RecordFiltersPanel from '../components/RecordFiltersPanel';
import type { DefectRecord } from '../models/defect-record';
import type { Locale } from '../i18n';
import { translate } from '../i18n';
import { todayDateOnly } from '../utils/date';

interface AnalysisPageProps {
  locale: Locale;
  records: readonly DefectRecord[];
}

function displayCategory(locale: Locale, label: string): string {
  return label.split(' · ').map((part) => part === 'Not analyzed'
    ? translate(locale, 'notAnalyzed')
    : part === 'Not specified' ? translate(locale, 'notSpecified') : part).join(' · ');
}

export default function AnalysisPage({ locale, records }: AnalysisPageProps) {
  const navigate = useNavigate();
  const today = todayDateOnly();
  const [filters, setFilters] = useState<RecordFilters>(() => createEmptyFilters());
  const filteredRecords = useMemo(() => applyRecordFilters(records, filters), [records, filters]);
  const analysis = useMemo(() => calculateAnalysis(filteredRecords, today), [filteredRecords, today]);

  const drillDown = (segment: Readonly<Record<string, string | null | undefined>>) => {
    const encoded = Object.fromEntries(Object.entries(segment).map(([key, value]) => [
      key,
      value === '' ? EMPTY_FILTER_QUERY_VALUE : value,
    ]));
    navigate(buildRecordsHref(filters, { view: 'all', ...encoded }));
  };

  const summaryItems = [
    { label: 'filteredRecords', value: analysis.summary.total, segment: { view: 'all' }, tone: '' },
    { label: 'open', value: analysis.summary.active, segment: { view: 'active' }, tone: 'analysis-open' },
    { label: 'completed', value: analysis.summary.completed, segment: { view: 'completed' }, tone: 'analysis-completed' },
    { label: 'rejectedMetric', value: analysis.summary.rejected, segment: { status: 'Rejected (xét)' }, tone: 'analysis-rejected' },
    { label: 'overdue', value: analysis.summary.overdue, segment: { tat: 'overdue', view: 'active' }, tone: 'analysis-overdue' },
  ] as const;
  const trendMax = Math.max(1, ...analysis.trend.map(({ count }) => count));

  return (
    <div className="page dashboard-page analysis-page">
      <header className="workspace-heading dashboard-heading">
        <div>
          <h2>{translate(locale, 'analysisTitle')}</h2>
          <p>{translate(locale, 'analysisDescription')}</p>
        </div>
        <span className="records-count">{translate(locale, 'rowsShown', { shown: filteredRecords.length, total: records.length })}</span>
      </header>

      <RecordFiltersPanel
        locale={locale}
        records={records}
        filters={filters}
        onChange={setFilters}
        onClear={() => setFilters(createEmptyFilters())}
      />

      <section className="analysis-summary" aria-label={translate(locale, 'analysisSummary')}>
        {summaryItems.map(({ label, value, segment, tone }) => (
          <button type="button" className={`analysis-summary-item ${tone}`} key={label} onClick={() => drillDown(segment)}>
            <span>{translate(locale, label)}</span>
            <strong>{value.toLocaleString()}</strong>
          </button>
        ))}
      </section>

      <div className="analysis-grid">
        <section className="analysis-panel trend-panel">
          <div className="analysis-panel-heading">
            <div><h3>{translate(locale, 'defectTrend')}</h3><p>{translate(locale, 'registeredMonthTrend')}</p></div>
            <span>{analysis.trend.length} {translate(locale, 'months')}</span>
          </div>
          {analysis.trend.length === 0 ? (
            <div className="dashboard-empty chart-empty">{translate(locale, 'noTrendData')}</div>
          ) : (
            <div className="trend-chart" role="list" aria-label={translate(locale, 'defectTrend')}>
              {analysis.trend.map(({ month, count }) => (
                <button
                  type="button"
                  className="trend-column"
                  key={month}
                  role="listitem"
                  aria-label={`${month}: ${count}`}
                  title={`${month}: ${count}`}
                  onClick={() => drillDown({ month })}
                >
                  <strong>{count}</strong>
                  <span className="trend-bar-track"><span style={{ height: `${Math.max(7, (count / trendMax) * 100)}%` }} /></span>
                  <small>{month}</small>
                </button>
              ))}
            </div>
          )}
        </section>

        <AnalysisBreakdown
          locale={locale}
          title={translate(locale, 'byPlant')}
          empty={translate(locale, 'noAnalysisCategories')}
          items={analysis.byPlant}
          onSelect={(item) => drillDown(encodeCategory(item))}
        />
        <AnalysisBreakdown
          locale={locale}
          title={translate(locale, 'byProjectModel')}
          empty={translate(locale, 'noAnalysisCategories')}
          items={analysis.byProjectModel}
          onSelect={(item) => drillDown(encodeCategory(item))}
        />
        <AnalysisBreakdown
          locale={locale}
          title={translate(locale, 'topReasons')}
          empty={translate(locale, 'noAnalysisCategories')}
          items={analysis.byReason}
          onSelect={(item) => drillDown(encodeCategory(item))}
        />
        <AnalysisBreakdown
          locale={locale}
          title={translate(locale, 'topDefectCodes')}
          empty={translate(locale, 'noAnalysisCategories')}
          items={analysis.byDefectCode}
          onSelect={(item) => drillDown(encodeCategory(item))}
        />
        <AnalysisBreakdown
          locale={locale}
          title={translate(locale, 'statusDistribution')}
          empty={translate(locale, 'noAnalysisCategories')}
          items={analysis.byStatus}
          className="status-distribution-panel"
          onSelect={(item) => drillDown(encodeCategory(item))}
        />
      </div>
    </div>
  );
}

function encodeCategory(item: AnalysisCategory): Record<string, string> {
  return Object.fromEntries(Object.entries(item.filters).map(([key, value]) => [
    key,
    value === '' ? EMPTY_FILTER_QUERY_VALUE : value!,
  ]));
}

interface AnalysisBreakdownProps {
  locale: Locale;
  title: string;
  empty: string;
  items: readonly AnalysisCategory[];
  onSelect: (item: AnalysisCategory) => void;
  className?: string;
}

function AnalysisBreakdown({ locale, title, empty, items, onSelect, className = '' }: AnalysisBreakdownProps) {
  const max = Math.max(1, ...items.map(({ count }) => count));
  return (
    <section className={`analysis-panel breakdown-panel ${className}`}>
      <div className="analysis-panel-heading"><h3>{title}</h3><span>{items.length ? translate(locale, 'topCount', { count: items.length }) : ''}</span></div>
      {items.length === 0 ? (
        <div className="dashboard-empty chart-empty">{empty}</div>
      ) : (
        <div className="analysis-bar-list">
          {items.map((item) => (
            <button type="button" className="analysis-bar-row" key={item.key} onClick={() => onSelect(item)} title={displayCategory(locale, item.label)}>
              <span className="analysis-bar-label">{displayCategory(locale, item.label)}</span>
              <span className="analysis-bar-track"><span style={{ width: `${Math.max(2, (item.count / max) * 100)}%` }} /></span>
              <strong>{item.count}</strong>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
