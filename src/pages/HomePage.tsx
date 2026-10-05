import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { calculateDefectKpis, calculatePlantStats } from '../business/kpi/kpi';
import { getTatDaysRemaining } from '../business/tat/tat';
import { isCompletedStatus } from '../business/status/status';
import type { DefectRecord } from '../models/defect-record';
import { todayDateOnly } from '../utils/date';
import type { Locale, MessageKey } from '../i18n';
import { translate } from '../i18n';

interface HomePageProps {
  locale: Locale;
  records: readonly DefectRecord[];
}

export default function HomePage({ locale, records }: HomePageProps) {
  const navigate = useNavigate();
  const today = todayDateOnly();
  const summary = calculateDefectKpis(records, today);
  const dueSoon = records.filter((record) => {
    if (isCompletedStatus(record.status)) return false;
    const days = getTatDaysRemaining(record, today);
    return days !== null && days >= 1 && days <= 3;
  }).length;
  const plants = useMemo(() => Object.entries(calculatePlantStats(records, today))
    .sort((left, right) => right[1].overdue - left[1].overdue || right[1].open - left[1].open), [records, today]);

  const metrics: Array<{ key: string; label: MessageKey; value: number; target: string; tone: string }> = [
    { key: 'total', label: 'total', value: summary.total, target: '/records?view=all', tone: '' },
    { key: 'active', label: 'open', value: summary.open, target: '/records?view=active', tone: 'metric-open' },
    { key: 'overdue', label: 'overdue', value: summary.overdue, target: '/records?view=active&tat=overdue', tone: 'metric-overdue' },
    { key: 'due-soon', label: 'dueSoon', value: dueSoon, target: '/records?view=active&tat=due-soon', tone: 'metric-soon' },
    { key: 'completed', label: 'completed', value: summary.completed, target: '/records?view=completed', tone: 'metric-completed' },
  ];

  const todayLabel = new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : locale === 'ko' ? 'ko-KR' : 'en-GB', {
    dateStyle: 'full',
  }).format(new Date(`${today}T00:00:00`));

  return (
    <div className="page home-page">
      <header className="home-heading">
        <div>
          <h2>{translate(locale, 'homeTitle')}</h2>
          <p>{translate(locale, 'homeDescription')}</p>
        </div>
        <div className="home-actions">
          <span className="home-today">{todayLabel}</span>
          <button type="button" className="secondary-button rejected-quick-link" onClick={() => navigate('/rejected')}>
            {translate(locale, 'rejectedMetric')} <strong>{summary.rejected}</strong>
          </button>
          <button type="button" className="primary-button" onClick={() => navigate('/records?import=1')}>
            <span aria-hidden="true">＋</span> {translate(locale, 'addTnpFile')}
          </button>
        </div>
      </header>

      <section className="metric-grid compact-metric-grid" aria-label={translate(locale, 'recordOverview')}>
        {metrics.map(({ key, label, value, target, tone }) => (
          <button type="button" className={`metric-card metric-action ${tone}`} key={key} onClick={() => navigate(target)}>
            <span className="metric-label">{translate(locale, label)}</span>
            <strong>{value.toLocaleString()}</strong>
            <span className="metric-link-hint">{translate(locale, 'openRecords')} <span aria-hidden="true">↗</span></span>
          </button>
        ))}
      </section>

      <nav className="home-module-links" aria-label={translate(locale, 'operationalModules')}>
        <span>{translate(locale, 'operationalModules')}</span>
        <button type="button" onClick={() => navigate('/analysis')}>{translate(locale, 'analysis')}</button>
        <button type="button" onClick={() => navigate('/tat')}>{translate(locale, 'tatMonitoringTitle')}</button>
        <button type="button" onClick={() => navigate('/corrective-actions')}>{translate(locale, 'corrective')}</button>
      </nav>

      <section className="section-heading home-section-heading">
        <div>
          <h3>{translate(locale, 'plantOverview')}</h3>
        </div>
        <span className="section-count">{plants.length} {locale === 'vi' ? 'nhà máy' : locale === 'ko' ? '개 공장' : 'plants'}</span>
      </section>
      {plants.length === 0 ? (
        <div className="empty-state">{translate(locale, 'noResults')}</div>
      ) : (
        <section className="plant-grid compact-plant-grid">
          {plants.map(([plant, stats]) => (
            <button
              type="button"
              className="plant-card plant-card-action"
              key={plant}
              onClick={() => navigate(`/records?view=active&plant=${encodeURIComponent(plant === 'Not analyzed' ? '__empty__' : plant)}`)}
            >
              <span className="plant-heading">
                <strong>{plant === 'Not analyzed' ? translate(locale, 'notAnalyzed') : plant}</strong>
                <span>{stats.total} {translate(locale, 'plantTotal')}</span>
              </span>
              <span className="plant-stats">
                <span><strong>{stats.open}</strong><small>{translate(locale, 'plantOpen')}</small></span>
                <span><strong>{stats.completed}</strong><small>{translate(locale, 'plantCompleted')}</small></span>
                <span><strong className={stats.overdue ? 'text-danger' : ''}>{stats.overdue}</strong><small>{translate(locale, 'plantOverdue')}</small></span>
              </span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
