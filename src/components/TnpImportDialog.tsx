import { useEffect, useRef, useState } from 'react';
import type { Locale } from '../i18n';
import { translate } from '../i18n';
import type { ImportHistoryEntry } from '../models/import-history';
import { recordRepository, importService } from '../app/services';
import type { ImportResult, ImportPreviewSummary } from '../services/import/importService';
import type { ParsedTnpFile } from '../services/import/tnpFileParser';

interface TnpImportDialogProps {
  locale: Locale;
  onClose: () => void;
  onImported: () => Promise<void>;
}

function formatTimestamp(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const tag = locale === 'vi' ? 'vi-VN' : locale === 'ko' ? 'ko-KR' : 'en-GB';
  return new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function rowTitle(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function TechnicalDetails({ locale, message }: { locale: Locale; message: string }) {
  return (
    <details className="technical-error-details">
      <summary>{translate(locale, 'technicalDetails')}</summary>
      <pre>{message}</pre>
    </details>
  );
}

export default function TnpImportDialog({ locale, onClose, onImported }: TnpImportDialogProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseFileButton = useRef<HTMLButtonElement>(null);
  const [parsed, setParsed] = useState<ParsedTnpFile | null>(null);
  const [preview, setPreview] = useState<ImportPreviewSummary | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [history, setHistory] = useState<ImportHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [parseError, setParseError] = useState('');
  const [importError, setImportError] = useState('');
  const [refreshWarning, setRefreshWarning] = useState('');
  const onCloseRef = useRef(onClose);
  const importingRef = useRef(importing);
  onCloseRef.current = onClose;
  importingRef.current = importing;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || importingRef.current) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    chooseFileButton.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    recordRepository.getImportHistory().then((entries) => {
      if (active) setHistory(entries.slice(0, 5));
    }).catch((reason: unknown) => {
      if (active) setHistoryError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, []);

  async function selectFile(file?: File) {
    if (!file) return;
    setParsed(null);
    setPreview(null);
    setResult(null);
    setParseError('');
    setImportError('');
    setRefreshWarning('');
    setParsing(true);
    try {
      const { parseTnpFile } = await import('../services/import/tnpFileParser');
      const next = await parseTnpFile(file);
      setParsed(next);
      if (next.canImport) {
        const rows = next.rows.map(({ record }) => record as Record<string, unknown>);
        try {
          setPreview(await importService.previewCanonicalRows(rows, file.name));
        } catch (reason) {
          setImportError(reason instanceof Error ? reason.message : translate(locale, 'importFailed'));
        }
      }
    } catch (reason) {
      setParseError(reason instanceof Error ? reason.message : translate(locale, 'parseError'));
    } finally {
      setParsing(false);
    }
  }

  async function importFile() {
    if (!parsed?.canImport || importing) return;
    setImporting(true);
    setImportError('');
    setRefreshWarning('');
    try {
      const rows = parsed.rows.map(({ record }) => record as Record<string, unknown>);
      const imported = await importService.importCanonicalRows(rows, { fileName: parsed.fileName });
      setResult(imported);
      setHistoryError('');
      setHistory((current) => [imported.history, ...current.filter((entry) => entry.id !== imported.history.id)].slice(0, 5));
      try {
        await onImported();
      } catch (reason) {
        setRefreshWarning(reason instanceof Error ? reason.message : String(reason));
      }
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : translate(locale, 'importFailed'));
    } finally {
      setImporting(false);
    }
  }

  const sampleRows = parsed?.rows.slice(0, 5) ?? [];
  const canCommit = Boolean(parsed?.canImport && preview && !parsing && !importing && !result);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !importing) onClose();
    }}>
      <section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <header className="dialog-header">
          <div>
          <h2 id="import-title">{translate(locale, 'importTitle')}</h2>
            <p>{translate(locale, 'importDescription')}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={translate(locale, 'close')} disabled={importing}>×</button>
        </header>

        <div className="import-dialog-body">
          <section className="file-select-row">
            <input
              ref={fileInput}
              className="visually-hidden"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                void selectFile(file);
              }}
            />
            <button ref={chooseFileButton} type="button" className="secondary-button" onClick={() => fileInput.current?.click()} disabled={parsing || importing}>
              {translate(locale, 'chooseFile')}
            </button>
            {parsed && <span className="selected-file-name">{translate(locale, 'selectedFile')}: <strong>{parsed.fileName}</strong></span>}
            {parsing && <span className="loading-inline" role="status">{translate(locale, 'parsingFile')}</span>}
          </section>

          {parseError && (
            <div role="alert">
              <p className="inline-error">{translate(locale, 'parseError')}</p>
              <TechnicalDetails locale={locale} message={parseError} />
            </div>
          )}

          {parsed && (
            <>
              <section className="import-summary-strip">
                <div><span>{translate(locale, 'parsedRows')}</span><strong>{parsed.rowsScanned}</strong></div>
                <div><span>{translate(locale, 'invalidRows')}</span><strong className={parsed.invalidRows ? 'text-danger' : ''}>{parsed.invalidRows}</strong></div>
                <div><span>{translate(locale, 'worksheet')}</span><strong>{parsed.sheetName}</strong></div>
                <div><span>{translate(locale, 'headerRow')}</span><strong>{parsed.headerRowNumber ?? '—'}</strong></div>
              </section>

              {parsed.recognizedHeaders.length > 0 && (
                <details className="import-mapped-headers">
                  <summary>{translate(locale, 'headersFound')} · {parsed.recognizedHeaders.length}</summary>
                  <div className="mapped-header-list">
                    {parsed.recognizedHeaders.map((header, index) => (
                      <span key={`${header.source}-${index}`}><code>{header.source}</code><b>→</b><code>{header.field}</code></span>
                    ))}
                  </div>
                </details>
              )}

              {parsed.warnings.length > 0 && (
                <details className="import-mapped-headers import-warning-details">
                  <summary>{translate(locale, 'warnings')} · {parsed.warnings.length}</summary>
                  <div className="import-warning-box" role="note">
                    <ul>{parsed.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
                  </div>
                </details>
              )}

              {parsed.errors.length > 0 && (
                <div className="import-error-box" role="alert">
                  <strong>{translate(locale, 'cannotImportWithErrors')}</strong>
                  <ul>
                    {parsed.errors.slice(0, 50).map((issue, index) => (
                      <li key={`${issue.rowNumber ?? 'file'}-${issue.field ?? ''}-${index}`}>
                        {issue.rowNumber ? `Row ${issue.rowNumber}${issue.field ? ` · ${issue.field}` : ''}: ` : ''}{issue.message}
                      </li>
                    ))}
                    {parsed.errors.length > 50 && <li>…{parsed.errors.length - 50} more errors</li>}
                  </ul>
                </div>
              )}

              {preview && (
                <section className="import-preview-section">
                  <div className="section-heading compact-heading">
                    <div>
                      <h3>{translate(locale, 'previewTitle')}</h3>
                      <p>{translate(locale, 'rowsShown', { shown: Math.min(sampleRows.length, parsed.rows.length), total: parsed.rows.length })}</p>
                    </div>
                    <span className="preview-counts">
                      {translate(locale, 'newRows')} {preview.added} · {translate(locale, 'updated')} {preview.updated} · {translate(locale, 'unchanged')} {preview.unchanged}
                    </span>
                  </div>
                  <div className="table-scroll preview-table-scroll">
                    <table className="records-table preview-table">
                      <thead><tr>
                        <th>{translate(locale, 'managementNumber')}</th>
                        <th>{translate(locale, 'plantColumn')}</th>
                        <th>{translate(locale, 'statusColumn')}</th>
                        <th>{translate(locale, 'deadlineColumn')}</th>
                        <th>{translate(locale, 'defectColumn')}</th>
                      </tr></thead>
                      <tbody>
                        {sampleRows.map(({ sourceRowNumber, record }) => (
                          <tr key={sourceRowNumber}>
                            <td>{rowTitle(record.mgmtNo) || '—'}</td>
                            <td>{rowTitle(record.plant) || '—'}</td>
                            <td>{rowTitle(record.status) || '—'}</td>
                            <td>{rowTitle(record.dueDate) || '—'}</td>
                            <td className="preview-defect-cell">{rowTitle(record.title) || rowTitle(record.defectDetails) || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {parsed.rows.length > sampleRows.length && <p className="table-footnote">{translate(locale, 'sampleMoreRows', { count: parsed.rows.length - sampleRows.length })}</p>}
                </section>
              )}
            </>
          )}

          {result && (
            <section className="import-result-box" role="status">
              <h3>{translate(locale, 'importComplete')}</h3>
              <div className="result-count-grid">
                <span>{translate(locale, 'parsedRows')}<strong>{result.total}</strong></span>
                <span>{translate(locale, 'newRows')}<strong>{result.added}</strong></span>
                <span>{translate(locale, 'updated')}<strong>{result.updated}</strong></span>
                <span>{translate(locale, 'unchanged')}<strong>{result.unchanged}</strong></span>
                <span>{translate(locale, 'invalidRows')}<strong>{parsed?.invalidRows ?? 0}</strong></span>
              </div>
            </section>
          )}
          {importError && (
            <div role="alert">
              <p className="inline-error">{translate(locale, 'importFailed')}</p>
              <TechnicalDetails locale={locale} message={importError} />
            </div>
          )}
          {refreshWarning && (
            <div role="status">
              <p className="inline-warning">{translate(locale, 'refreshFailed')}</p>
              <TechnicalDetails locale={locale} message={refreshWarning} />
            </div>
          )}

          <details className="import-safety-details">
            <summary>{translate(locale, 'importSafetyDetails')}</summary>
            <p>{translate(locale, 'importAtomicNote')}</p>
          </details>

          <section className="import-history-section">
            <h3>{translate(locale, 'recentImports')}</h3>
            {historyError ? (
              <div role="status">
                <p className="inline-warning">{translate(locale, 'historyLoadFailed')}</p>
                <TechnicalDetails locale={locale} message={historyError} />
              </div>
            ) : history.length === 0 ? <p>{translate(locale, 'noImportHistory')}</p> : (
              <ul className="import-history-list">
                {history.map((entry) => (
                  <li key={entry.id}>
                    <div><strong>{entry.files[0]?.fileName || 'TNP import'}</strong><span>{formatTimestamp(entry.importedAt, locale)}</span></div>
                    <small>+{entry.added} · ↻{entry.updated} · ={entry.unchanged} / {entry.total}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="dialog-footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={importing}>{translate(locale, 'close')}</button>
          {parsed?.canImport && !result && (
            <button type="button" className="primary-button" onClick={() => void importFile()} disabled={!canCommit}>
              {importing ? translate(locale, 'importing') : translate(locale, 'importNow')}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
