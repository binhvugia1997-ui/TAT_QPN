/**
 * Electron wiring for the owner's native file bridge.
 *
 * All decisions live in `bridgeCore.ts`; this file only talks to Electron and to the
 * loopback server. Only the channels named in `BRIDGE_CHANNELS` are reachable from the
 * renderer, and the preload exposes nothing else.
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BridgeValidationError,
  checkManagedReportPath,
  createFileTokenStore,
  describePickedFile,
  normalizeBridgeRecordId,
} from './bridgeCore';
import type { DesktopSettings } from './settings';
import type { PortableLayout } from './paths';
import type { OwnedServer } from './serverProcess';

export const BRIDGE_CHANNELS = [
  'tnp:get-desktop-state',
  'tnp:pick-report-file',
  'tnp:attach-report',
  'tnp:open-report',
  'tnp:reveal-data-folder',
  'tnp:create-backup',
  'tnp:set-lan-enabled',
  'tnp:set-workstation-label',
  'tnp:restart-server',
] as const;

export type BridgeChannel = (typeof BRIDGE_CHANNELS)[number];

export interface BridgeContext {
  getLayout(): PortableLayout;
  getServer(): OwnedServer | undefined;
  getSettings(): DesktopSettings;
  setLanEnabled(enabled: boolean): DesktopSettings;
  setWorkstationLabel(label: string): DesktopSettings;
  restartServer(): Promise<{ baseUrl: string; port: number }>;
}

interface ServerResponse<T> {
  ok: boolean;
  status?: number;
  body?: T;
  message?: string;
}

/** Calls the loopback server; never lets a raw stack reach the renderer. */
async function callServer<T>(server: OwnedServer | undefined, method: string, route: string, body?: unknown): Promise<ServerResponse<T>> {
  if (!server) return { ok: false, message: 'The TNP server is not running.' };
  try {
    const response = await fetch(`${server.baseUrl}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed: T | undefined;
    try {
      parsed = text ? (JSON.parse(text) as T) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const detail = parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `The server returned ${response.status}.`;
      return { ok: false, status: response.status, body: parsed, message: detail };
    }
    return { ok: true, status: response.status, body: parsed };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'The TNP server could not be reached.' };
  }
}

export function registerBridge(context: BridgeContext): void {
  const tokens = createFileTokenStore();

  const handle = (channel: BridgeChannel, listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, value: await listener(event, ...args) };
      } catch (error) {
        // Only intended validation messages are surfaced; everything else is generic.
        const expected = error instanceof BridgeValidationError || error instanceof Error && /^The |Refusing|A record|The record|The server|The selection|The selected|Another|The managed|The TNP/u.test(error.message);
        return {
          ok: false,
          error: expected ? error.message : 'The desktop could not complete that action.',
        };
      }
    });
  };

  handle('tnp:get-desktop-state', async () => {
    const server = context.getServer();
    const layout = context.getLayout();
    const status = await callServer<Record<string, unknown>>(server, 'GET', '/api/status');
    return {
      server: {
        running: Boolean(server),
        port: server?.port ?? null,
        baseUrl: server?.baseUrl ?? null,
        pid: server?.pid ?? null,
      },
      status: status.ok ? status.body : null,
      statusError: status.ok ? null : status.message ?? null,
      layout: {
        root: layout.root,
        dataDir: layout.dataDir,
        backupsDir: layout.backupsDir,
        reportsDir: layout.reportsDir,
        databaseFile: layout.databaseFile,
        portable: layout.portable,
        rootNote: layout.rootNote,
      },
      settings: context.getSettings(),
      security: {
        authentication: false,
        tls: false,
        // Explicitly surfaced so nobody mistakes this build for a hardened deployment.
        warning:
          'This TEST build has no authentication and no TLS. LAN mode makes the data readable and '
          + 'writable by anyone on the same local network.',
      },
    };
  });

  /** Native picker; the chosen path never leaves the main process. */
  handle('tnp:pick-report-file', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Select the report file to attach',
      buttonLabel: 'Attach',
      properties: ['openFile'],
      filters: [
        { name: 'Reports', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'csv', 'xlsx', 'docx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const window = BrowserWindow.getFocusedWindow();
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };

    const picked = describePickedFile(result.filePaths[0] as string);
    const token = tokens.issue(picked);
    return { canceled: false, token, fileName: picked.fileName, sizeBytes: picked.sizeBytes };
  });

  handle('tnp:attach-report', async (_event, recordId: unknown, token: unknown) => {
    const id = normalizeBridgeRecordId(recordId);
    const server = context.getServer();
    if (!server) throw new BridgeValidationError('The TNP server is not running.');

    const entry = tokens.consume(typeof token === 'string' ? token : '');
    if (!entry) throw new BridgeValidationError('The file selection expired. Please choose the file again.');
    if (!fs.existsSync(entry.filePath)) throw new BridgeValidationError('The selected file is no longer available.');

    const bytes = await fs.promises.readFile(entry.filePath);
    const response = await fetch(`${server.baseUrl}/api/records/${encodeURIComponent(String(id))}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-TNP-File-Name': encodeURIComponent(entry.fileName) },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    if (!response.ok) {
      const detail = parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `The server returned ${response.status}.`;
      throw new BridgeValidationError(detail);
    }
    return parsed;
  });

  /**
   * Opens a record's managed report in the Windows default application. The path comes from
   * the loopback server (which applies the Phase 5 containment checks) and is re-verified
   * against the managed folder before anything is opened.
   */
  handle('tnp:open-report', async (_event, recordId: unknown) => {
    const id = normalizeBridgeRecordId(recordId);
    const server = context.getServer();
    if (!server) throw new BridgeValidationError('The TNP server is not running.');

    const resolved = await callServer<{ absolutePath?: unknown; originalName?: unknown }>(
      server,
      'GET',
      `/api/records/${encodeURIComponent(String(id))}/report-path`,
    );
    if (!resolved.ok || !resolved.body) {
      throw new BridgeValidationError(resolved.message ?? 'This record has no report available.');
    }

    const check = checkManagedReportPath(resolved.body.absolutePath, context.getLayout().reportsDir);
    if (!check.allowed || !check.resolvedPath) {
      throw new BridgeValidationError(check.reason ?? 'The managed report could not be opened.');
    }

    const message = await shell.openPath(check.resolvedPath);
    if (message) throw new BridgeValidationError(message || 'Windows could not open the report.');
    return { opened: true, fileName: resolved.body.originalName ?? path.basename(check.resolvedPath) };
  });

  handle('tnp:reveal-data-folder', async () => {
    const target = context.getLayout().dataDir;
    const message = await shell.openPath(target);
    if (message) throw new BridgeValidationError(message || 'Windows could not open the data folder.');
    return { opened: true, path: target };
  });

  handle('tnp:create-backup', async () => {
    const result = await callServer<unknown>(context.getServer(), 'POST', '/api/backups', { reason: 'manual' });
    if (!result.ok) throw new BridgeValidationError(result.message ?? 'The backup could not be created.');
    return result.body;
  });

  handle('tnp:set-lan-enabled', async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new BridgeValidationError('LAN mode must be enabled or disabled.');
    const settings = context.setLanEnabled(enabled);
    return { settings, restartRequired: true };
  });

  handle('tnp:set-workstation-label', async (_event, label: unknown) => {
    const value = typeof label === 'string' ? label : '';
    return { settings: context.setWorkstationLabel(value), restartRequired: false };
  });

  handle('tnp:restart-server', async () => {
    const result = await context.restartServer();
    return result;
  });
}

export function unregisterBridge(): void {
  for (const channel of BRIDGE_CHANNELS) ipcMain.removeHandler(channel);
}
