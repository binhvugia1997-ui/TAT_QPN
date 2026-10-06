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

  // Surface an unexpected child exit instead of leaving a dead window behind.
  void started.exited.then(({ code, signal }) => {
    if (shuttingDown || !server || server !== started) return;
    server = undefined;
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

  void mainWindow.loadURL(baseUrl);
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
  appendLog(`desktop start; portable=${layout.portable}; root=${layout.root}`);

  try {
    server = await startServer();
  } catch (error) {
    appendLog(`server start failed: ${error instanceof Error ? error.message : String(error)}`);
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
