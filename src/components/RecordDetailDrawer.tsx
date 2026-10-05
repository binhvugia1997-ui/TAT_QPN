import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Locale } from '../i18n';
import { translate } from '../i18n';
import type { DefectRecord } from '../models/defect-record';
import { LEGACY_STATUS_VALUES } from '../business/status/status';
import { recordService } from '../app/services';

interface RecordDetailDrawerProps {
  locale: Locale;
  record: DefectRecord;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

interface EditableFields {
  status: string;
  dueDate: string;
  completedDate: string;
  mqisCode: string;
  pic: string;
  notes: string;
  caFileLink: string;
}

const EDITABLE_FIELDS = new Set(['status', 'dueDate', 'completedDate', 'mqisCode', 'pic', 'notes', 'caFileLink']);

function fieldLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./u, (letter) => letter.toUpperCase());
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function originLabel(record: DefectRecord, locale: Locale): string {
  const key = record.recordSource === 'legacy-seed'
    ? 'recordOriginSeed'
    : record.recordSource === 'import' ? 'recordOriginImport' : 'recordOriginManual';
  return translate(locale, key);
}

function initialEditableFields(record: DefectRecord): EditableFields {
  return {
    status: record.status ?? '',
    dueDate: record.dueDate ?? '',
    completedDate: record.completedDate ?? '',
    mqisCode: record.mqisCode ?? '',
    pic: record.pic ?? '',
    notes: record.notes ?? '',
    caFileLink: record.caFileLink ?? '',
  };
}

export default function RecordDetailDrawer({ locale, record, onClose, onSaved }: RecordDetailDrawerProps) {
  const [form, setForm] = useState<EditableFields>(() => initialEditableFields(record));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState('');
  const [refreshWarning, setRefreshWarning] = useState(false);
  const [refreshDetails, setRefreshDetails] = useState('');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const onCloseRef = useRef(onClose);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const savingRef = useRef(saving);
  onCloseRef.current = onClose;
  savingRef.current = saving;

  useEffect(() => {
    setForm(initialEditableFields(record));
    setError('');
    setErrorDetails('');
    setRefreshWarning(false);
    setRefreshDetails('');
    setSaved(false);
  }, [record.id]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || savingRef.current) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const sourceFields = useMemo(() => Object.entries(record)
    .filter(([key]) => !EDITABLE_FIELDS.has(key) && key !== 'recordSource')
    .sort(([left], [right]) => left.localeCompare(right)), [record]);

  const update = (field: keyof EditableFields, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setError('');
    setErrorDetails('');
    setRefreshWarning(false);
    setRefreshDetails('');
    setSaved(false);
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setErrorDetails('');
    setRefreshWarning(false);
    setRefreshDetails('');
    setSaved(false);
    try {
      await recordService.updateRecord(record.id, {
        status: form.status,
        dueDate: form.dueDate || null,
        completedDate: form.completedDate || null,
        mqisCode: form.mqisCode,
        pic: form.pic,
        notes: form.notes,
        caFileLink: form.caFileLink,
      });
      setSaved(true);
      try {
        await onSaved();
      } catch (reason) {
        setRefreshWarning(true);
        setRefreshDetails(reason instanceof Error ? reason.message : String(reason));
      }
    } catch (reason) {
      setError(translate(locale, 'saveFailed'));
      setErrorDetails(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function copyLink() {
    if (!form.caFileLink) return;
    try {
      await navigator.clipboard.writeText(form.caFileLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError(translate(locale, 'copyLinkUnavailable'));
      setErrorDetails('');
    }
  }

  const statusOptions = [...LEGACY_STATUS_VALUES];
  if (form.status && !statusOptions.includes(form.status as (typeof LEGACY_STATUS_VALUES)[number])) {
    statusOptions.push(form.status as (typeof LEGACY_STATUS_VALUES)[number]);
  }

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <aside className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title">
        <header className="drawer-header">
          <div>
            <p className="page-eyebrow">{record.mgmtNo || `#${String(record.id)}`}</p>
            <h2 id="detail-title">{translate(locale, 'detailTitle')}</h2>
            <p className="drawer-record-title">{record.title || record.defectDetails || translate(locale, 'untitled')}</p>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-button" onClick={onClose} aria-label={translate(locale, 'close')} disabled={saving}>×</button>
        </header>

        <form className="detail-form" onSubmit={save}>
          <section className="detail-edit-section">
            <h3>{translate(locale, 'editManagement')}</h3>
            <label className="field-control">
              <span>{translate(locale, 'statusField')}</span>
              <select value={form.status} onChange={(event) => update('status', event.target.value)}>
                {!form.status && <option value="">—</option>}
                {statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <div className="detail-date-grid">
              <label className="field-control">
                <span>{translate(locale, 'dueDateField')}</span>
                <input type="date" value={form.dueDate} onChange={(event) => update('dueDate', event.target.value)} />
              </label>
              <label className="field-control">
                <span>{translate(locale, 'completedDateField')}</span>
                <input type="date" value={form.completedDate} onChange={(event) => update('completedDate', event.target.value)} />
              </label>
            </div>
            <label className="field-control">
              <span>{translate(locale, 'mqisCodeField')}</span>
              <input type="text" value={form.mqisCode} onChange={(event) => update('mqisCode', event.target.value)} />
            </label>
            <h3>{translate(locale, 'correctiveFollowUp')}</h3>
            <label className="field-control">
              <span>{translate(locale, 'picField')}</span>
              <input type="text" value={form.pic} onChange={(event) => update('pic', event.target.value)} />
            </label>
            <label className="field-control">
              <span>{translate(locale, 'remarkField')}</span>
              <textarea value={form.notes} onChange={(event) => update('notes', event.target.value)} rows={4} />
            </label>
            <label className="field-control">
              <span>{translate(locale, 'caFileField')}</span>
              <input type="text" value={form.caFileLink} onChange={(event) => update('caFileLink', event.target.value)} />
              <small>{translate(locale, 'caFileHelp')}</small>
            </label>
            {form.caFileLink && (
              <button type="button" className="secondary-button copy-link-button" onClick={copyLink}>
                {copied ? translate(locale, 'copied') : translate(locale, 'copyLink')}
              </button>
            )}
          </section>

          <details className="source-details">
            <summary>{translate(locale, 'sourceData')} · {sourceFields.length}</summary>
            <dl className="source-field-list">
              {sourceFields.map(([key, value]) => (
                <div className="source-field-row" key={key}>
                  <dt>{fieldLabel(key)}</dt>
                  <dd>{displayValue(value)}</dd>
                </div>
              ))}
              <div className="source-field-row">
                <dt>{translate(locale, 'recordOriginField')}</dt>
                <dd>{originLabel(record, locale)}</dd>
              </div>
            </dl>
          </details>

          {error && (
            <div role="alert">
              <p className="inline-error">{error}</p>
              {errorDetails && (
                <details className="technical-error-details">
                  <summary>{translate(locale, 'technicalDetails')}</summary>
                  <pre>{errorDetails}</pre>
                </details>
              )}
            </div>
          )}
          {refreshWarning && (
            <div role="status">
              <p className="inline-warning">{translate(locale, 'refreshFailed')}</p>
              {refreshDetails && (
                <details className="technical-error-details">
                  <summary>{translate(locale, 'technicalDetails')}</summary>
                  <pre>{refreshDetails}</pre>
                </details>
              )}
            </div>
          )}
          {saved && <p className="inline-success" role="status">{translate(locale, 'saved')}</p>}
          <footer className="drawer-footer">
            <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>{translate(locale, 'close')}</button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? translate(locale, 'saving') : translate(locale, 'saveChanges')}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
