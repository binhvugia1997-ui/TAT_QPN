import { useCallback, useEffect, useState } from 'react';
import type { Locale, MessageKey } from '../i18n';
import { translate } from '../i18n';
import { getDesktopBridge } from '../services/desktop/desktopBridge';
import { isValidUncPath, looksLikeNetworkPath } from '../utils/uncPath';
import type { TnpDesktopUpdateSummary, TnpDesktopState, TnpUpdateSourceValidation } from '../../desktop/types/tnpDesktop';

/**
 * Owner-only panel, rendered exclusively inside the Windows TEST wrapper.
 *
 * It answers four questions and nothing more: where the data physically lives, whether other PCs
 * can reach it, how to take a snapshot, and whether this PC can actually see its update folder.
 * It is deliberately not an admin console — the Phase 5 UI stays compact, and this panel appears
 * only when `window.tnpDesktop` exists.
 */
interface DesktopPanelProps {
  locale: Locale;
  /** Lets the page refresh after a server restart changes the port. */
  onServerRestarted?: () => void;
}

export function DesktopPanel({ locale, onServerRestarted }: DesktopPanelProps) {
  const [state, setState] = useState<TnpDesktopState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** Only ever set by the explicit Check button: a dead share is discovered by timeout. */
  const [sourceCheck, setSourceCheck] = useState<TnpUpdateSourceValidation | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    try {
      setState(await desktop.getDesktopState());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate(locale, 'desktopLoadFailed'));
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!getDesktopBridge()) return null;

  async function run(action: () => Promise<unknown>, successKey: MessageKey) {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(translate(locale, successKey));
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate(locale, 'desktopActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleLan(enabled: boolean) {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await desktop.setLanEnabled(enabled);
      // LAN only takes effect on the next server start, so restart and reload the page.
      await desktop.restartServer();
      setNotice(translate(locale, 'desktopRestarted'));
      await load();
      onServerRestarted?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate(locale, 'desktopActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Validates the folder currently in the input, not the one already saved: the point is to catch a
   * typo before it is persisted, and to explain a saved value that stopped working.
   *
   * The shape is checked locally first. A path that cannot be a UNC path will fail on the network
   * too, and waiting seconds for that answer teaches the operator to stop pressing the button.
   */
  async function checkUpdateSource(value: string) {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    setChecking(true);
    setError('');
    setSourceCheck(null);
    try {
      const trimmed = value.trim();
      // Only a value that looks like a network path is shape-checked first: a local folder is a
      // legitimate value here, and the network stack is the only authority on whether it resolves.
      if (looksLikeNetworkPath(trimmed) && !isValidUncPath(trimmed)) {
        setSourceCheck({
          state: 'invalid-manifest',
          source: trimmed,
          message: translate(locale, 'updateSourceShapeInvalid'),
          usable: false,
          manifest: null,
          channelMatches: null,
          checkedAt: new Date().toISOString(),
        });
        return;
      }
      setSourceCheck(await desktop.validateUpdateSource(trimmed));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate(locale, 'desktopActionFailed'));
    } finally {
      setChecking(false);
    }
  }

  return (
    <article className="panel desktop-panel">
      <h3>{translate(locale, 'desktopPanelTitle')}</h3>

      <dl className="desktop-facts">
        <div>
          <dt>{translate(locale, 'desktopMode')}</dt>
          <dd>
            {state
              ? state.layout.portable
                ? translate(locale, 'desktopPortable')
                : translate(locale, 'desktopUserFolder')
              : '—'}
          </dd>
        </div>
        <div>
          <dt>{translate(locale, 'desktopDataFolder')}</dt>
          <dd><code>{state?.layout.dataDir ?? '—'}</code></dd>
        </div>
        <div>
          <dt>{translate(locale, 'desktopBackupsFolder')}</dt>
          <dd><code>{state?.layout.backupsDir ?? '—'}</code></dd>
        </div>
        <div>
          <dt>{translate(locale, 'desktopReportsFolder')}</dt>
          <dd><code>{state?.layout.reportsDir ?? '—'}</code></dd>
        </div>
        <div>
          <dt>{translate(locale, 'desktopServerProcess')}</dt>
          <dd>
            {state?.server.running
              ? `${translate(locale, 'desktopRunning')} · 127.0.0.1:${state.server.port}${state.server.pid ? ` · pid ${state.server.pid}` : ''}`
              : translate(locale, 'desktopStopped')}
          </dd>
        </div>
      </dl>

      {state && !state.layout.portable && <p className="hint">{state.layout.rootNote}</p>}

      <label className="desktop-row">
        <input
          type="checkbox"
          checked={state?.settings.lanEnabled ?? false}
          disabled={busy}
          onChange={(event) => void toggleLan(event.target.checked)}
        />
        <span>{translate(locale, 'desktopLanToggle')}</span>
      </label>
      <p className="hint">{translate(locale, 'desktopLanHelp')}</p>

      <label className="desktop-row desktop-label-row">
        <span>{translate(locale, 'desktopWorkstationLabel')}</span>
        <input
          type="text"
          value={state?.settings.workstationLabel ?? ''}
          maxLength={60}
          disabled={busy}
          placeholder={translate(locale, 'desktopWorkstationPlaceholder')}
          onChange={(event) => {
            const desktop = getDesktopBridge();
            const value = event.target.value;
            if (!desktop) return;
            setState((previous) => (previous ? { ...previous, settings: { ...previous.settings, workstationLabel: value } } : previous));
            void desktop.setWorkstationLabel(value).catch(() => undefined);
          }}
        />
      </label>
      <p className="hint">{translate(locale, 'desktopWorkstationHelp')}</p>

      <label className="desktop-row desktop-label-row">
        <span>{translate(locale, 'updateSourceLabel')}</span>
        <input
          type="text"
          value={state?.settings.updateSource ?? ''}
          maxLength={500}
          disabled={busy}
          spellCheck={false}
          placeholder={translate(locale, 'updateSourcePlaceholder')}
          onChange={(event) => {
            const desktop = getDesktopBridge();
            const value = event.target.value;
            if (!desktop) return;
            setState((previous) => (previous ? { ...previous, settings: { ...previous.settings, updateSource: value } } : previous));
            void desktop.setUpdateSource(value).catch(() => undefined);
          }}
        />
      </label>
      <p className="hint">{translate(locale, 'updateSourceHelp')}</p>
      <UpdateSourceFacts locale={locale} summary={state?.update ?? null} />
      <p className="hint">{translate(locale, 'updateSourceCheckHelp')}</p>

      <div className="desktop-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy || checking}
          onClick={() => void checkUpdateSource(state?.settings.updateSource ?? '')}
        >
          {checking ? translate(locale, 'updateSourceChecking') : translate(locale, 'updateSourceCheck')}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void run(() => getDesktopBridge()!.checkForUpdate(), 'updateUpToDate')}
        >
          {translate(locale, 'updateCheckNow')}
        </button>
        <button type="button" disabled={busy} onClick={() => void run(() => getDesktopBridge()!.createBackup(), 'desktopBackupDone')}>
          {translate(locale, 'desktopBackupNow')}
        </button>
        <button type="button" disabled={busy} onClick={() => void run(() => getDesktopBridge()!.revealDataFolder(), 'desktopFolderOpened')}>
          {translate(locale, 'desktopRevealFolder')}
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void load()}>
          {translate(locale, 'desktopRefresh')}
        </button>
      </div>

      {notice && <p className="hint desktop-notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {sourceCheck && (
        <p className={sourceCheck.usable ? 'hint desktop-notice' : 'error'} role="status">
          {sourceCheck.message}
        </p>
      )}

      {state && (
        <p className="warning-note">
          {translate(locale, 'desktopSecurityTitle')} {state.security.warning}
        </p>
      )}
    </article>
  );
}

/**
 * The three facts an operator needs before trusting an update folder: which build is running now,
 * which folder the app will really read, and whether the channel matches. Rendered as a plain list
 * because every value in it comes from the main process and must be copyable for a support chat.
 */
function UpdateSourceFacts({
  locale,
  summary,
}: {
  locale: Locale;
  summary: TnpDesktopUpdateSummary | null | undefined;
}) {
  if (!summary) {
    return <p className="hint">{translate(locale, 'desktopUpdateUnavailable')}</p>;
  }
  const installed = summary.installed
    ? `${summary.installed.version} · build ${summary.installed.build}`
    : '—';
  return (
    <dl className="desktop-facts">
      <div>
        <dt>{translate(locale, 'desktopInstalledVersion')}</dt>
        <dd>{installed}</dd>
      </div>
      <div>
        <dt>{translate(locale, 'desktopResolvedSource')}</dt>
        <dd>
          <code>{summary.resolvedSource ?? translate(locale, 'desktopNoSource')}</code>
        </dd>
      </div>
    </dl>
  );
}

export default DesktopPanel;
