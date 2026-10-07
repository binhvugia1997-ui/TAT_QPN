/**
 * Electron wiring for the LAN auto-update.
 *
 * All decisions live in `updaterCore.ts`; this file only talks to Electron: where the runtime
 * folder is, where the updater writes, how the helper is spawned and how the window is closed.
 *
 * The updater is only active in the packaged portable build. In development the repository
 * checkout is the "runtime", and replacing it would destroy source control state, so checking
 * is refused there rather than half-supported.
 */
import { app, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createFileUpdateSource, resolveUpdateSourceRoot } from '../update/source';
import { resolveUpdateLayout } from '../update/layout';
import type { UpdateLayout } from '../update/layout';
import { readAppVersion } from '../update/manifest';
import type { AppVersion } from '../update/manifest';
import { TNP_LAUNCHER_NAME } from '../update/packageInspect';
import { UpdateCoordinator } from '../update/updaterCore';
import type { UpdateHost } from '../update/updaterCore';
import type { UpdateState } from '../update/updateTypes';
import type { HelperPlan } from '../update/helperMain';

export const UPDATE_CHANNELS = [
  'tnp:get-update-state',
  'tnp:check-update',
  'tnp:install-update',
  'tnp:dismiss-update',
  'tnp:set-update-source',
] as const;

/** Pushed to the renderer whenever the updater's state changes. */
export const UPDATE_EVENT_CHANNEL = 'tnp:update-state';

export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export interface UpdaterContext {
  runtimeRoot: string;
  /** Persistent folders; recorded only so the layout can prove they are preserved. */
  persistentDirs: { dataDir: string; backupsDir: string; reportsDir: string };
  settings(): { updateSource: string; updateChannel: string; updateChecksEnabled: boolean };
  setUpdateSource(value: string): { updateSource: string; updateChannel: string; updateChecksEnabled: boolean };
  log(line: string): void;
  broadcast(state: UpdateState): void;
  env?: Record<string, string | undefined>;
}

export interface ManagedUpdater {
  coordinator: UpdateCoordinator;
  layout: UpdateLayout;
  local: AppVersion;
  enabled: boolean;
  startBackgroundCheck(): void;
  unregister(): void;
}

/**
 * Resolves the runtime folder of the packaged app: the folder that contains
 * `resources`, the launcher EXE and the Electron libraries.
 */
export function resolveRuntimeRoot(input: { resourcesPath?: string; isPackaged: boolean; cwd?: string }): string {
  if (!input.isPackaged) return input.cwd ?? process.cwd();
  const resources = input.resourcesPath ?? process.resourcesPath;
  return path.dirname(path.resolve(resources));
}

export function readLocalVersion(appPackageJson: string): AppVersion {
  const parsed = JSON.parse(fs.readFileSync(appPackageJson, 'utf8')) as Record<string, unknown>;
  return readAppVersion(parsed);
}

/** The launcher inside a runtime folder, falling back to the only EXE if it was renamed. */
export function resolveLauncher(runtimeRoot: string): string {
  const expected = path.join(runtimeRoot, TNP_LAUNCHER_NAME);
  if (fs.existsSync(expected)) return expected;
  try {
    const found = fs.readdirSync(runtimeRoot).find((entry) => entry.toLowerCase().endsWith('.exe'));
    if (found) return path.join(runtimeRoot, found);
  } catch {
    // Fall through to the expected name; the caller will report the failure.
  }
  return expected;
}

/** The helper script that ships inside a runtime folder. */
export function resolveHelperScript(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'resources', 'app', 'dist', 'desktop', 'update', 'helperMain.js');
}

export function createUpdaterHost(input: {
  runtimeRoot: string;
  stagedDir: () => string;
  log(line: string): void;
  broadcast(state: UpdateState): void;
}): UpdateHost {
  return {
    log: input.log,
    emit: input.broadcast,
    pid: () => process.pid,
    // After the swap the new launcher sits at the same path in the runtime folder.
    relaunchCommand: () => resolveLauncher(input.runtimeRoot),
    relaunchArgs: () => [],
    spawnHelper: (plan: HelperPlan) => {
      const stagedExe = resolveLauncher(input.stagedDir());
      const helperScript = resolveHelperScript(input.stagedDir());
      const child = spawn(stagedExe, [helperScript, '--plan', plan.planFile], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: input.stagedDir(),
        env: {
          ...process.env,
          // Runs the Electron binary as a plain Node runtime: no Node install is needed on
          // the Owner PC, and no updater tooling has to be shipped separately.
          ELECTRON_RUN_AS_NODE: '1',
          TNP_UPDATE_HELPER: '1',
        },
      });
      child.unref();
      input.log(`spawned updater helper from ${stagedExe} (pid ${child.pid ?? 'unknown'})`);
      return child.pid ?? 0;
    },
    quit: (reason: string) => {
      input.log(`quit requested: ${reason}`);
      // main.ts's before-quit handler stops the server and closes SQLite gracefully.
      app.quit();
    },
  };
}

export function createUpdater(context: UpdaterContext): ManagedUpdater {
  const layout = resolveUpdateLayout({
    runtimeRoot: context.runtimeRoot,
    dataDir: context.persistentDirs.dataDir,
    backupsDir: context.persistentDirs.backupsDir,
    reportsDir: context.persistentDirs.reportsDir,
  });
  const appPackageJson = path.join(context.runtimeRoot, 'resources', 'app', 'package.json');
  const local = readLocalVersion(appPackageJson);

  const coordinator = new UpdateCoordinator({
    host: createUpdaterHost({
      runtimeRoot: layout.runtimeRoot,
      stagedDir: () => layout.stagingDir,
      log: (line) => context.log(`[update] ${line}`),
      broadcast: context.broadcast,
    }),
    layout,
    local,
    channel: context.settings().updateChannel,
  });

  coordinator.loadLastResult();
  applySource();

  const handle = (channel: UpdateChannel, listener: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, value: await listener(...args) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'The update could not be completed.' };
      }
    });
  };

  handle('tnp:get-update-state', () => coordinator.getState());
  handle('tnp:check-update', async () => {
    const result = await coordinator.check();
    return result ? { status: result.status } : { status: 'disabled' };
  });
  handle('tnp:install-update', async () => {
    await coordinator.install();
    return { started: true };
  });
  handle('tnp:dismiss-update', () => {
    coordinator.dismiss();
    return { dismissed: true };
  });
  handle('tnp:set-update-source', (_source: unknown) => {
    const value = typeof _source === 'string' ? _source : '';
    context.setUpdateSource(value);
    applySource();
    return { source: value, state: coordinator.getState() };
  });

  function applySource(): void {
    const settings = context.settings();
    const resolved = resolveUpdateSourceRoot({
      settingsSource: settings.updateSource,
      settingsChannel: settings.updateChannel,
      checksEnabled: settings.updateChecksEnabled,
      env: context.env ?? (process.env as Record<string, string | undefined>),
    });
    if (!resolved) {
      coordinator.configure(null);
      return;
    }
    try {
      coordinator.configure(createFileUpdateSource({ root: resolved.root }));
      context.log(`[update] source configured: ${resolved.root} (channel ${resolved.channel})`);
    } catch (error) {
      coordinator.configure(null);
      context.log(`[update] the configured source is unusable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    coordinator,
    layout,
    local,
    enabled: true,
    /**
     * Fire-and-forget by contract: startup must never wait for the share, and a failure here
     * is only ever logged.
     */
    startBackgroundCheck() {
      setTimeout(() => {
        void coordinator.check().catch((error: unknown) => {
          context.log(`[update] the background check failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, 4_000);
    },
    unregister() {
      for (const channel of UPDATE_CHANNELS) ipcMain.removeHandler(channel);
    },
  };
}
