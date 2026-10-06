import { useCallback, useEffect, useState } from 'react';
import type { Locale, MessageKey } from '../i18n';
import { translate } from '../i18n';
import { getDesktopBridge } from '../services/desktop/desktopBridge';
import type { TnpUpdateState, TnpUpdateStage } from '../../desktop/types/tnpDesktop';

/**
 * The LAN update prompt.
 *
 * Rendered only inside the Windows TEST wrapper, and only when there is something for the
 * owner to act on. It never blocks the application: TNP is fully usable behind it, and an
 * unreachable update folder shows nothing at all here.
 *
 * Progress is real byte progress reported by the copy loop — not a timer and not an estimate.
 */
interface UpdateNoticeProps {
  locale: Locale;
}

const STAGE_KEYS: Partial<Record<TnpUpdateStage, MessageKey>> = {
  COPYING: 'updateStageCopying',
  VERIFYING: 'updateStageVerifying',
  VALIDATING: 'updateStageValidating',
  STAGING: 'updateStageStaging',
  WAITING_FOR_EXIT: 'updateStageWaiting',
  INSTALLING: 'updateStageInstalling',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateNotice({ locale }: UpdateNoticeProps) {
  const [state, setState] = useState<TnpUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    try {
      setState(await desktop.getUpdateState());
    } catch {
      // The desktop panel is the place to report bridge problems; stay quiet here.
    }
  }, []);

  useEffect(() => {
    void load();
    const desktop = getDesktopBridge();
    if (!desktop) return undefined;
    return desktop.onUpdateState((next) => { setState(next); });
  }, [load]);

  const desktop = getDesktopBridge();
  if (!desktop || !state) return null;

  const { phase } = state;
  if (phase !== 'update-available' && phase !== 'downloading' && phase !== 'installing' && phase !== 'failed' && phase !== 'complete') {
    return null;
  }

  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setActionError('');
    try {
      await action();
      await load();
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? translate(locale, 'updateFailed', { message: reason.message })
          : translate(locale, 'updateFailed', { message: 'unknown' }),
      );
    } finally {
      setBusy(false);
    }
  }

  const stageLabel = state.stage && STAGE_KEYS[state.stage]
    ? translate(locale, STAGE_KEYS[state.stage] as MessageKey)
    : null;

  return (
    <section className="update-notice" data-phase={phase} aria-live="polite">
      {phase === 'update-available' && state.available && (
        <>
          <div className="update-notice-body">
            <h2>{translate(locale, 'updateAvailableTitle')}</h2>
            <p>
              {translate(locale, 'updateCurrentVersion', {
                version: state.local.version,
                build: state.local.build,
              })}
            </p>
            <p>
              {translate(locale, 'updateAvailableVersion', {
                version: state.available.version,
                build: state.available.build,
              })}
            </p>
            {state.available.releaseNotes && (
              <p className="hint">
                {translate(locale, 'updateReleaseNotes')}: {state.available.releaseNotes}
              </p>
            )}
            <p className="hint">
              {translate(locale, 'updatePublishedAt', {
                publishedAt: new Date(state.available.publishedAt).toLocaleString(),
              })}
            </p>
          </div>
          <div className="update-notice-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void act(() => desktop.dismissUpdate())}
            >
              {translate(locale, 'updateLater')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => desktop.installUpdate())}
            >
              {translate(locale, 'updateInstall')}
            </button>
          </div>
          <p className="hint update-safety">{translate(locale, 'updateSafetyNote')}</p>
        </>
      )}

      {(phase === 'downloading' || phase === 'installing') && (
        <div className="update-progress">
          <p>{stageLabel ?? translate(locale, 'updateChecking')}</p>
          {state.progress && (
            <>
              <div
                className="update-progress-bar"
                role="progressbar"
                aria-valuenow={Math.round(state.progress.percent)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span style={{ width: `${Math.min(100, Math.max(0, state.progress.percent))}%` }} />
              </div>
              <p className="hint">
                {translate(locale, 'updateProgress', {
                  percent: state.progress.percent.toFixed(1),
                  done: formatBytes(state.progress.bytesTransferred),
                  total: formatBytes(state.progress.totalBytes),
                })}
                {' · '}
                {translate(locale, 'updateRate', { rate: formatRate(state.progress.transferRate) })}
              </p>
            </>
          )}
          <p className="hint update-safety">{translate(locale, 'updateSafetyNote')}</p>
        </div>
      )}

      {phase === 'failed' && (
        <div className="update-failed">
          <p className="error">
            {translate(locale, 'updateFailed', { message: state.error ?? 'unknown' })}
          </p>
          {state.lastResult && !state.lastResult.ok && (
            <p className="hint">{translate(locale, 'updateRolledBack')}</p>
          )}
          <p className="hint update-safety">{translate(locale, 'updateSafetyNote')}</p>
        </div>
      )}

      {phase === 'complete' && state.lastResult && (
        <div className="update-complete">
          <p>
            {translate(locale, 'updateComplete', {
              from: state.lastResult.previousBuild,
              to: state.lastResult.targetBuild,
            })}
          </p>
        </div>
      )}

      {actionError && <p className="error">{actionError}</p>}
    </section>
  );
}

export default UpdateNotice;
