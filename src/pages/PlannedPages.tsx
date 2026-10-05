import type { DefectRecord } from '../models/defect-record';
import type { Locale } from '../i18n';
import AnalysisDashboard from './AnalysisPage';
import RecordsWorkspace from './RecordsWorkspace';
import TatMonitoringPage from './TatMonitoringPage';

interface DashboardPageProps {
  locale: Locale;
  records: readonly DefectRecord[];
}

interface RecordsPageProps extends DashboardPageProps {
  onRecordsChanged: () => Promise<void>;
}

export function RecordsPage(props: RecordsPageProps) {
  return <RecordsWorkspace {...props} mode="records" />;
}

export function AnalysisPage({ locale, records }: DashboardPageProps) {
  return <AnalysisDashboard locale={locale} records={records} />;
}

export function TatPage({ locale, records }: DashboardPageProps) {
  return <TatMonitoringPage locale={locale} records={records} />;
}

export function CorrectiveActionsPage(props: RecordsPageProps) {
  return <RecordsWorkspace {...props} mode="corrective" />;
}

export function RejectedPage(props: RecordsPageProps) {
  return <RecordsWorkspace {...props} mode="rejected" />;
}
