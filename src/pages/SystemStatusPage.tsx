import { useCallback, useEffect, useState } from 'react';
import type { Locale, MessageKey } from '../i18n';
import { translate } from '../i18n';
import { serverApi } from '../app/services';
import type { AuditSummary, BackupSummary, ServerStatus } from '../services/server/serverRecordRepository';
import { downloadExport, exportIndexedDbData } from '../services/server/browserExport';
import { DesktopPanel } from '../components/DesktopPanel';

interface SystemStatusPageProps {
  locale: Locale;
  status: ServerStatus;
  onStatusRefreshed: () => Promise<void>;
}

const OPERATION_FILTERS = ['', 'record.update', 'record.create', 'import.commit', 'backup.manual'] as const;

const BACKUP_KIND_LABELS: Record<string, MessageKey> = {
  daily: 'backupKindDaily',
  manual: 'backupKindManual',
  'pre-import': 'backupKindPreImport',
};

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SystemStatusPage({ locale, status, onStatusRefreshed }: SystemStatusPageProps) {
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [events, setEvents] = useState<AuditSummary[]>([]);
  const [operation, setOperation] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const [backupList, audit] = await Promise.all([
      serverApi.backups(),
      serverApi.audit({ limit: 50, operation: operation || undefined }),
    ]);
    setBackups(backupList.backups);
    setEvents(audit.events);
  }, [operation]);

  useEffect(() => {
    reload().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [reload]);

  async function createBackup() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const entry = await serverApi.createBackup(translate(locale, 'manualBackupNote'));
      setMessage(translate(locale, 'backupCreated', { name: entry.fileName }));
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function exportBrowserData() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      // Read-only: the legacy browser store is copied out and never modified.
      const exported = await exportIndexedDbData();
      const fileName = downloadExport(exported);
      setMessage(translate(locale, 'browserExportSaved', { count: exported.records.length, name: fileName }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const lanAddresses = status.server.lanAddresses;

  return (
    <section className="page system-page">
      <header className="page-head">
        <p className="page-eyebrow">{translate(locale, 'systemEyebrow')}</p>
        <h2>{translate(locale, 'systemTitle')}</h2>
        <p className="page-description">{translate(locale, 'systemDescription')}</p>
      </header>

      <div className="system-grid">
        <article className="panel">
          <h3>{translate(locale, 'serverPanelTitle')}</h3>
          <dl className="status-list">
            <div><dt>{translate(locale, 'storageLabel')}</dt><dd>{status.storage === 'sqlite' ? 'SQLite' : status.storage}</dd></div>
            <div><dt>{translate(locale, 'databaseLabel')}</dt><dd>{status.database.path}</dd></div>
            <div><dt>{translate(locale, 'schemaVersionLabel')}</dt><dd>{status.database.schemaVersion}</dd></div>
            <div><dt>{translate(locale, 'recordCountLabel')}</dt><dd>{status.database.recordCount}</dd></div>
            <div><dt>{translate(locale, 'bindAddressLabel')}</dt><dd>{status.server.bindAddress}:{status.server.actualPort}</dd></div>
            <div><dt>{translate(locale, 'directoriesLabel')}</dt><dd>{status.directories.data} · {status.directories.backups} · {status.directories.reports}</dd></div>
          </dl>
          <button type="button" className="secondary-button" onClick={() => { void onStatusRefreshed(); void reload(); }} disabled={busy}>
            {translate(locale, 'refresh')}
          </button>
        </article>

        <article className="panel">
          <h3>{translate(locale, 'lanPanelTitle')}</h3>
          <p className={`lan-state${status.server.lanEnabled ? ' on' : ''}`}>
            {status.server.lanEnabled ? translate(locale, 'lanEnabled') : translate(locale, 'lanDisabled')}
          </p>
          {status.server.lanEnabled && lanAddresses.length > 0 && (
            <ul className="lan-address-list">
              {lanAddresses.map((entry) => (
                <li key={`${entry.interface}-${entry.address}`}>
                  <code>{entry.url}</code>
                  <span>{entry.interface}</span>
                </li>
              ))}
            </ul>
          )}
          {status.server.lanEnabled && lanAddresses.length === 0 && (
            <p className="lan-empty">{translate(locale, 'lanNoAddresses')}</p>
          )}
          <p className="security-warning" role="note">{status.security.warning}</p>
          <p className="hint">{translate(locale, 'lanHowToEnable')}</p>
        </article>

        <article className="panel">
          <h3>{translate(locale, 'backupPanelTitle')}</h3>
          <p className="hint">{translate(locale, 'backupHint')}</p>
          <button type="button" className="primary-button" onClick={createBackup} disabled={busy}>
            {translate(locale, 'createBackup')}
          </button>
          <ul className="backup-list">
            {backups.length === 0 && <li className="empty">{translate(locale, 'noBackups')}</li>}
            {backups.map((backup) => (
              <li key={backup.id}>
                <code>{backup.fileName}</code>
                <span>{translate(locale, BACKUP_KIND_LABELS[backup.kind] ?? 'backupKindManual')}</span>
                <span>{formatBytes(backup.sizeBytes)}</span>
                <span>{formatTimestamp(backup.createdAt)}</span>
              </li>
            ))}
          </ul>
          <p className="hint">{translate(locale, 'noRestoreNote')}</p>
        </article>

        <article className="panel">
          <h3>{translate(locale, 'migrationPanelTitle')}</h3>
          <p className="hint">{translate(locale, 'migrationHint')}</p>
          <button type="button" className="secondary-button" onClick={exportBrowserData} disabled={busy}>
            {translate(locale, 'exportBrowserData')}
          </button>
          <p className="hint">{translate(locale, 'migrationCommand')}</p>
          <code className="command-line">npm run migrate:indexeddb -- --file &lt;export.json&gt;</code>
          <code className="command-line">npm run migrate:indexeddb -- --file &lt;export.json&gt; --confirm</code>
        </article>
      </div>

      {/* Rendered only inside the Windows TEST wrapper; absent in a browser tab. */}
      <DesktopPanel locale={locale} onServerRestarted={onStatusRefreshed} />

      <article className="panel history-panel">
        <header className="history-head">
          <h3>{translate(locale, 'changeHistoryTitle')}</h3>
          <label className="field-control compact">
            <span>{translate(locale, 'historyFilter')}</span>
            <select value={operation} onChange={(event) => setOperation(event.target.value)}>
              {OPERATION_FILTERS.map((value) => (
                <option key={value || 'all'} value={value}>
                  {value === '' ? translate(locale, 'historyAll') : value}
                </option>
              ))}
            </select>
          </label>
        </header>
        <ul className="history-list">
          {events.length === 0 && <li className="empty">{translate(locale, 'noHistory')}</li>}
          {events.map((event) => (
            <li key={event.seq}>
              <div className="history-line">
                <strong>{event.operation}</strong>
                {event.mgmtNo && <code>{event.mgmtNo}</code>}
                <span>{formatTimestamp(event.occurredAt)}</span>
                {event.clientLabel && <span className="client-label">{event.clientLabel}</span>}
              </div>
              {event.changes.length > 0 && (
                <ul className="change-list">
                  {event.changes.map((change) => (
                    <li key={change.field}>
                      <span>{change.field}</span>
                      <span className="old">{String(change.oldValue ?? '—')}</span>
                      <span className="arrow" aria-hidden="true">→</span>
                      <span className="new">{String(change.newValue ?? '—')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        <p className="hint">{translate(locale, 'historyNote')}</p>
      </article>

      {message && <p className="inline-success" role="status">{message}</p>}
      {error && (
        <div role="alert">
          <p className="inline-error">{error}</p>
        </div>
      )}
    </section>
  );
}
