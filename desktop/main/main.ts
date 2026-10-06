/**
 * Electron main process for the Windows TEST portable build.
 *
 * Responsibilities, in order: claim a single instance, resolve the portable data folders,
 * start the Phase 5 server as a child process, wait until it answers on loopback, then show
 * the existing React UI served by that same server. No SQLite and no business logic lives
 * here — the desktop is a window plus a native-file bridge.
 */
import { BrowserWindow, app, dialog, Menu } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerBridge, unregisterBridge } from './bridge';
import { describeLoadFailure, openDiagnosticLog, startupErrorUrl } from './diagnostics';
import type { DiagnosticLog, StartupFailure } from './diagnostics';
import { resolvePortableLayout, realProbe } from './paths';
import type { PortableLayout } from './paths';
import { readSettings, writeSettings } from './settings';
import type { DesktopSettings } from './settings';
import { ServerStartError, realDeps, startOwnedServer } from './serverProcess';
import type { OwnedServer } from './serverProcess';

const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;

let layout: PortableLayout | undefined;
let settings: DesktopSettings | undefined;
let server: OwnedServer | undefined;
let mainWindow: Electron.BrowserWindow | undefined;
let shuttingDown = false;
let diagnostics: DiagnosticLog | undefined;
/** Port the owned server actually bound to, reported in every failure page. */
let activePort: number | null = null;

const UI_MOUNT_TIMEOUT_MS = 10_000;
const UI_MOUNT_POLL_MS = 250;

function log(stage: Parameters<NonNullable<typeof diagnostics>['write']>[0], message: string): void {
  diagnostics?.write(stage, message);
}

function resolveLayout(): PortableLayout {
  const executableDir = path.dirname(app.getPath('exe'));
  const resolved = resolvePortableLayout({
    executableDir,
    userDataDir: app.getPath('userData'),
    // Packaged: <resources>/app. Dev: the repository root.
    appDir: app.isPackaged ? path.join(process.resourcesPath, 'app') : process.cwd(),
    env: process.env as Record<string, string | undefined>,
    probe: realProbe,
  });
  fs.mkdirSync(resolved.dataDir, { recursive: true });
  return resolved;
}

function serverEnv(): Record<string, string> {
  if (!layout) throw new Error('The portable layout has not been resolved.');
  const base = process.env as Record<string, string | undefined>;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    TNP_DATA_DIR: layout.dataDir,
    TNP_BACKUPS_DIR: layout.backupsDir,
    TNP_REPORTS_DIR: layout.reportsDir,
    TNP_SEED_FILE: layout.seedFile,
    TNP_STATIC_DIR: layout.staticDir,
    TNP_CLIENT_LABEL: settings?.workstationLabel || '',
    // Enables the loopback-only managed-report path lookup the native bridge needs.
    TNP_DESKTOP_BRIDGE: '1',
    NODE_ENV: 'production',
  };
}

async function startServer(): Promise<OwnedServer> {
  if (!layout || !settings) throw new Error('The desktop has not finished initialising.');
  log('server-spawn', `starting ${layout.serverEntry} on requested port ${settings.port}`);
  const started = await startOwnedServer(
    {
      nodeExecutable: process.execPath,
      serverEntry: layout.serverEntry,
      env: serverEnv(),
      preferredPort: settings.port,
      lanEnabled: settings.lanEnabled,
      bindHost: settings.lanEnabled ? '0.0.0.0' : '127.0.0.1',
    },
    realDeps,
  );

  activePort = started.port;
  log('server-ready', `ready on ${started.baseUrl} (pid ${started.pid ?? 'unknown'}, lan=${started.lanEnabled})`);
  if (started.port !== settings.port) {
    log('server-ready', `note: requested port ${settings.port} was unavailable, using ${started.port}`);
  }

  // Surface an unexpected child exit instead of leaving a dead window behind.
  void started.exited.then(({ code, signal }) => {
    if (shuttingDown || !server || server !== started) return;
    server = undefined;
    log('server-exited', `the local server exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'TNP server stopped',
        message: `The local TNP server stopped unexpectedly (code ${code ?? 'null'}${signal ? `, ${signal}` : ''}).`,
        detail: 'Close and reopen the app to start it again. Your data in the data folder is untouched.',
        buttons: ['OK'],
      });
    }
  });

  return started;
}

async function restartServer(): Promise<{ baseUrl: string; port: number }> {
  const previous = server;
  server = undefined;
  await previous?.stop();
  const started = await startServer();
  server = started;
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(started.baseUrl);
  }
  return { baseUrl: started.baseUrl, port: started.port };
}

/**
 * Never leave the owner with a featureless white window: put the reason, the port and the
 * failing URL in the window itself, and record the same facts in the diagnostic log.
 */
function showStartupFailure(failure: StartupFailure): void {
  log('load-failed', `${failure.reason}${failure.detail ? ` — ${failure.detail}` : ''}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    void mainWindow.loadURL(startupErrorUrl(failure)).catch(() => undefined);
  }
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    title: 'TNP Defect Management did not start',
    message: failure.reason,
    detail: [
      failure.detail ?? '',
      failure.url ? `URL: ${failure.url}` : '',
      failure.port !== undefined && failure.port !== null ? `Port: ${failure.port}` : '',
      layout ? `Diagnostic log: ${layout.diagnosticLogFile}` : '',
    ].filter(Boolean).join('\n'),
    buttons: ['Close'],
  };
  const prompt = mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
  void prompt.catch(() => undefined);
}

function createWindow(baseUrl: string): void {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 1024,
    minHeight: 640,
    title: 'TNP Defect Management — TEST (portable)',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

  // Keep the window on its own loopback server; external navigation and popups are blocked.
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(baseUrl)) event.preventDefault();
  });
  mainWindow.webContents.on('did-attach-webview', (event) => event.preventDefault());

  const contents = mainWindow.webContents;

  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 is a benign abort during redirects.
    showStartupFailure({
      reason: 'The interface failed to load.',
      detail: describeLoadFailure(errorCode, errorDescription),
      port: activePort,
      url: validatedURL || baseUrl,
      logFile: layout?.diagnosticLogFile,
      dataDir: layout?.dataDir,
    });
  });

  contents.on('render-process-gone', (_event, details) => {
    log('renderer-gone', `renderer process gone: ${details.reason}`);
    showStartupFailure({
      reason: 'The interface stopped responding.',
      detail: `The renderer process ended unexpectedly (${details.reason}).`,
      port: activePort,
      url: baseUrl,
      logFile: layout?.diagnosticLogFile,
      dataDir: layout?.dataDir,
    });
  });

  // TEST build only: capture renderer console output so UAT can report without DevTools.
  contents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) log('renderer-console', `${level >= 3 ? 'error' : 'warning'} ${message} (${sourceId}:${line})`);
  });

  contents.on('did-finish-load', () => {
    log('load-finished', `loaded ${contents.getURL()}`);
    void verifyUiMounted(baseUrl);
  });

  log('window-created', `window created; loading ${baseUrl}`);
  void contents.loadURL(baseUrl).catch((error: unknown) => {
    showStartupFailure({
      reason: 'The interface failed to load.',
      detail: error instanceof Error ? error.message : String(error),
      port: activePort,
      url: baseUrl,
      logFile: layout?.diagnosticLogFile,
      dataDir: layout?.dataDir,
    });
  });
}

/**
 * A page can load successfully and still render nothing — that is exactly the blank-window
 * failure this build has already had once. Confirm React actually mounted, and say so if not.
 */
async function verifyUiMounted(baseUrl: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  const deadline = Date.now() + UI_MOUNT_TIMEOUT_MS;
  const probe = "(() => { const r = document.getElementById('root'); return r ? r.childElementCount : -1; })()";

  while (Date.now() < deadline) {
    if (mainWindow.isDestroyed() || shuttingDown) return;
    try {
      const children = (await contents.executeJavaScript(probe, true)) as number;
      if (typeof children === 'number' && children > 0) {
        log('ui-mounted', `React mounted (${children} top-level nodes)`);
        return;
      }
    } catch (error) {
      log('ui-blank', `could not inspect the page: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, UI_MOUNT_POLL_MS); });
  }

  showStartupFailure({
    reason: 'The interface loaded but did not render.',
    detail:
      'The page was served, but the application never mounted into #root. This usually means a '
      + 'bundled script or stylesheet was not served correctly. Check the diagnostic log for '
      + 'renderer console errors.',
    port: activePort,
    url: contents.getURL() || baseUrl,
    logFile: layout?.diagnosticLogFile,
    dataDir: layout?.dataDir,
  });
}

async function reportStartupFailure(error: unknown): Promise<void> {
  const message = error instanceof ServerStartError
    ? error.message
    : error instanceof Error ? error.message : String(error);
  const diagnostics = error instanceof ServerStartError ? error.diagnostics.join('\n') : '';
  const detail = [
    diagnostics ? `\nServer output:\n${diagnostics}\n` : '',
    layout ? `Data folder: ${layout.dataDir}` : '',
    layout ? `Log file: ${layout.logFile}` : '',
    layout && !layout.portable ? layout.rootNote : '',
  ].filter(Boolean).join('\n');

  await dialog.showMessageBox({
    type: 'error',
    title: 'TNP Defect Management could not start',
    message,
    detail,
    buttons: ['Close'],
  });
}

function appendLog(line: string): void {
  if (!layout) return;
  try {
    fs.mkdirSync(layout.dataDir, { recursive: true });
    fs.appendFileSync(layout.logFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // Logging must never be the reason startup fails.
  }
}

async function boot(): Promise<void> {
  // Two desktops on the same data folder would fight over the SQLite lock; refuse early.
  if (!app.requestSingleInstanceLock()) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'TNP Defect Management is already running',
      message: 'Another copy of this app is already using this data folder.',
      detail: 'Close the other window first, then open this app again.',
      buttons: ['Close'],
    });
    app.quit();
    return;
  }

  layout = resolveLayout();
  settings = readSettings(layout.settingsFile);
  diagnostics = openDiagnosticLog(layout.diagnosticLogFile);
  log('layout', `portable=${layout.portable}; root=${layout.root}; static=${layout.staticDir}; server=${layout.serverEntry}`);
  appendLog(`desktop start; portable=${layout.portable}; root=${layout.root}`);

  try {
    server = await startServer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('server-exited', `server start failed: ${message}`);
    appendLog(`server start failed: ${message}`);
    await reportStartupFailure(error);
    app.quit();
    return;
  }

  appendLog(`server ready on ${server.baseUrl} (pid ${server.pid ?? 'unknown'})`);
  createWindow(server.baseUrl);

  registerBridge({
    getLayout: () => layout as PortableLayout,
    getServer: () => server,
    getSettings: () => settings as DesktopSettings,
    setLanEnabled: (enabled) => {
      settings = writeSettings((layout as PortableLayout).settingsFile, { ...(settings as DesktopSettings), lanEnabled: enabled });
      return settings;
    },
    setWorkstationLabel: (label) => {
      settings = writeSettings((layout as PortableLayout).settingsFile, { ...(settings as DesktopSettings), workstationLabel: label });
      return settings;
    },
    restartServer,
  });

  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

app.whenReady().then(() => { void boot(); }).catch((error: unknown) => { void reportStartupFailure(error); });

app.on('window-all-closed', () => {
  app.quit();
});

let quitConfirmed = false;

app.on('before-quit', (event) => {
  shuttingDown = true;
  unregisterBridge();
  diagnostics?.close();
  const owned = server;
  server = undefined;
  if (!owned) return;

  // Let the child close SQLite and release its lock before Electron tears the process down.
  if (quitConfirmed) return;
  quitConfirmed = true;
  event.preventDefault();
  void owned.stop()
    .catch(() => undefined)
    .finally(() => { app.quit(); });
});

// No popups and no webviews anywhere in the app.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
