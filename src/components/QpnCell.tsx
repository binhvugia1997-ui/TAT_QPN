import { useRef, useState, type ChangeEvent } from 'react';
import type { DefectRecord } from '../models/defect-record';
import type { Locale } from '../i18n';
import { translate } from '../i18n';
import type { AttachedReport } from '../business/records/recordsTable';
import { getDesktopBridge } from '../services/desktop/desktopBridge';
import { serverApi } from '../services/server/serverRecordRepository';

interface QpnCellProps {
  locale: Locale;
  record: DefectRecord;
  /** The report linked to this record, or undefined when nothing is attached. */
  report: AttachedReport | undefined;
  /** Called after any successful change so the row updates without a full reload. */
  onChanged: () => void;
}

/**
 * Compact QPN actions rendered inside the Records table.
 *
 * This is a thin surface over the report attachment infrastructure the Detail drawer
 * already uses — the same `serverApi` calls, the same desktop native-open bridge, the
 * same per-record streaming endpoint. It adds no storage, no schema and no second
 * attachment path, and every call is bound to this row's canonical record id, so the
 * server's containment and path validation still apply.
 */
export default function QpnCell({ locale, record, report, onChanged }: QpnCellProps) {
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const desktop = getDesktopBridge();

  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await action();
      onChanged();
    } catch {
      setError(translate(locale, 'reportAttachFailed'));
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
  }

  function pickFile(): void {
    if (desktop) {
      void run(async () => {
        const picked = await desktop.pickReportFile();
        if (picked.canceled || !picked.token) return;
        await desktop.attachReport(record.id, picked.token);
      });
      return;
    }
    fileInput.current?.click();
  }

  async function handlePickedFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await run(async () => {
      await serverApi.attachReport(record.id, file);
    });
  }

  async function openNatively(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await desktop?.openReport(record.id);
    } catch {
      setError(translate(locale, 'reportOpenNativeFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="qpn-cell-content" title={error || report?.originalName || undefined}>
      {report ? (
        <>
          {desktop ? (
            <button
              type="button"
              className="qpn-action"
              disabled={busy}
              title={report.originalName}
              onClick={(event) => {
                stop(event);
                void openNatively();
              }}
            >
              <span aria-hidden="true">📄</span> {translate(locale, 'qpnOpen')}
            </button>
          ) : (
            <a
              className="qpn-action"
              href={serverApi.reportUrl(record.id)}
              target="_blank"
              rel="noreferrer"
              title={report.originalName}
              onClick={stop}
            >
              <span aria-hidden="true">📄</span> {translate(locale, 'qpnOpen')}
            </a>
          )}
          <button
            type="button"
            className="qpn-more"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={translate(locale, 'qpnMore')}
            disabled={busy}
            onClick={(event) => {
              stop(event);
              setMenuOpen((open) => !open);
            }}
          >
            ⋯
          </button>
          <span className="qpn-menu" role="menu" hidden={!menuOpen}>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={(event) => {
                stop(event);
                pickFile();
              }}
            >
              {translate(locale, 'qpnChange')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={(event) => {
                stop(event);
                void run(async () => {
                  await serverApi.unlinkReport(record.id);
                });
              }}
            >
              {translate(locale, 'qpnRemove')}
            </button>
          </span>
        </>
      ) : (
        <button
          type="button"
          className="qpn-action qpn-add"
          disabled={busy}
          title={translate(locale, 'reportAttach')}
          onClick={(event) => {
            stop(event);
            pickFile();
          }}
        >
          <span aria-hidden="true">＋</span> {translate(locale, 'qpnAdd')}
        </button>
      )}
      {!desktop && (
        <input
          ref={fileInput}
          type="file"
          className="qpn-file-input"
          aria-label={translate(locale, 'reportAttach')}
          onChange={(event) => {
            void handlePickedFile(event);
          }}
        />
      )}
    </span>
  );
}
