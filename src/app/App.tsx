import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import type { Locale } from '../i18n';
import { translate } from '../i18n';
import HomePage from '../pages/HomePage';
import { AnalysisPage, CorrectiveActionsPage, RecordsPage, RejectedPage, TatPage } from '../pages/PlannedPages';
import type { DefectRecord } from '../models/defect-record';
import type { SeedResult } from '../services/database/recordRepository';
import { initializeDevelopmentData, recordService } from './services';

interface LoadedData {
  records: DefectRecord[];
  seed: SeedResult;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: LoadedData }
  | { status: 'error'; error: Error };

function DatabaseStatePage({ locale, state }: { locale: Locale; state: Exclude<LoadState, { status: 'ready' }> }) {
  if (state.status === 'loading') {
    return <div className="blocking-state" role="status">{translate(locale, 'loading')}</div>;
  }
  return (
    <div className="blocking-state error-state" role="alert">
      <h2>{translate(locale, 'loadError')}</h2>
      <details>
        <summary>{translate(locale, 'technicalDetails')}</summary>
        <pre>{state.error.message}</pre>
      </details>
    </div>
  );
}

export default function App() {
  const [locale, setLocale] = useState<Locale>('en');
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    initializeDevelopmentData().then(
      (data) => {
        if (active) setLoadState({ status: 'ready', data });
      },
      (reason: unknown) => {
        if (active) {
          const error = reason instanceof Error ? reason : new Error(String(reason));
          setLoadState({ status: 'error', error });
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const refreshRecords = useCallback(async () => {
    const records = await recordService.getAllRecords();
    setLoadState((current) => current.status === 'ready'
      ? { status: 'ready', data: { ...current.data, records } }
      : current);
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout locale={locale} onLocaleChange={setLocale} />}>
          {loadState.status === 'ready' ? (
            <>
              <Route index element={<HomePage locale={locale} records={loadState.data.records} />} />
              <Route path="records" element={<RecordsPage locale={locale} records={loadState.data.records} onRecordsChanged={refreshRecords} />} />
              <Route path="analysis" element={<AnalysisPage locale={locale} records={loadState.data.records} />} />
              <Route path="tat" element={<TatPage locale={locale} records={loadState.data.records} />} />
              <Route path="corrective-actions" element={<CorrectiveActionsPage locale={locale} records={loadState.data.records} onRecordsChanged={refreshRecords} />} />
              <Route path="rejected" element={<RejectedPage locale={locale} records={loadState.data.records} onRecordsChanged={refreshRecords} />} />
              <Route path="*" element={<HomePage locale={locale} records={loadState.data.records} />} />
            </>
          ) : (
            <Route path="*" element={<DatabaseStatePage locale={locale} state={loadState} />} />
          )}
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
