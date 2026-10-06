/**
 * The client update coordinator.
 *
 * Deliberately Electron-free: every interaction with the host (logging, UI updates, spawning
 * the helper, quitting) goes through the injected `UpdateHost`, so the whole install path —
 * including the SHA mismatch, ZIP-slip and rollback cases — is unit tested against a real
 * filesystem.
 *
 * Invariants enforced here:
 *   • The running runtime is never modified until the package has been copied, hashed,
 *     validated and extracted into `.tnp-update/staging/`.
 *   • A SHA256 mismatch aborts before a single runtime file is touched.
 *   • The running EXE is never overwritten by this process: a detached helper running from the
 *     staged runtime does the swap after TNP exits.
 *   • `data/`, `backups/` and `reports/` are never enumerated, copied or deleted.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertSafeEntries, extractZip, listZipEntries } from './archive';
import { checkForUpdate, createDismissalList } from './checkForUpdate';
import type { UpdateCheckResult, UpdateSource } from './checkForUpdate';
import { digestsMatch, sha256File } from './hash';
import { createInstallPlan } from './install';
import type { UpdateLayout } from './layout';
import { describeVersion } from './manifest';
import type { AppVersion, UpdateManifest } from './manifest';
import {
  REQUIRED_PACKAGE_ENTRIES,
  TNP_LAUNCHER_NAME,
  checkPackageIdentity,
  describeInspection,
  inspectPackageEntries,
  resolveStagedEntry,
} from './packageInspect';
import { computePercent } from './transfer';
import type { TransferProgress } from './transfer';
import { initialUpdateState } from './updateTypes';
import type { AvailableUpdateSummary, UpdateStage, UpdateState } from './updateTypes';
import type { HelperPlan } from './helperMain';

export interface UpdateHost {
  /** Appends a line to the updater's own log file (never the business audit trail). */
  log(line: string): void;
  /** Pushes the current state to the owner's UI. */
  emit(state: UpdateState): void;
  /** Spawns the detached helper and returns its pid. */
  spawnHelper(plan: HelperPlan): number;
  /** Asks TNP to shut down gracefully. */
  quit(reason: string): void;
  pid(): number;
  /** Path of the executable the helper should relaunch. */
  relaunchCommand(): string;
  relaunchArgs(): string[];
  now?(): number;
}

export type PackageSource = UpdateSource & {
  root: string;
  packagePath(name: string): string;
  copyPackage(name: string, destination: string, onProgress?: (progress: TransferProgress) => void): Promise<number>;
};

export class UpdateError extends Error {
  constructor(message: string, readonly stage: UpdateStage) {
    super(message);
    this.name = 'UpdateError';
  }
}

export interface CoordinatorOptions {
  host: UpdateHost;
  layout: UpdateLayout;
  local: AppVersion;
  channel: string;
}

export class UpdateCoordinator {
  private state: UpdateState;
  private source: PackageSource | null = null;
  private manifest: UpdateManifest | null = null;
  private dismissed = createDismissalList();
  private busy = false;

  constructor(private readonly options: CoordinatorOptions) {
    this.state = initialUpdateState({ version: options.local.version, build: options.local.build });
  }

  getState(): UpdateState {
    return this.state;
  }

  /** Sets or clears the LAN source. Clearing it disables checking without an error. */
  configure(source: PackageSource | null): void {
    this.source = source;
    this.patch({ source: source ? source.description : null, ...(source ? {} : { phase: 'disabled' }) });
  }

  /** Reads the result the helper wrote on the previous run, so the owner sees the outcome. */
  loadLastResult(): void {
    try {
      const raw = fs.readFileSync(path.join(this.options.layout.updateDir, 'last-update-result.json'), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      this.patch({
        lastResult: {
          ok: parsed.ok === true,
          stage: String(parsed.stage ?? ''),
          previousBuild: Number(parsed.previousBuild ?? 0),
          targetBuild: Number(parsed.targetBuild ?? 0),
          message: String(parsed.message ?? ''),
        },
        phase: parsed.ok === true ? 'complete' : this.state.phase,
      });
    } catch {
      // No previous run — nothing to report.
    }
  }

  /**
   * Background check. Never throws and never blocks startup: an unreachable or malformed
   * source is recorded as `unavailable` and the app carries on.
   */
  async check(): Promise<UpdateCheckResult | null> {
    if (!this.source) {
      this.patch({ phase: 'disabled' });
      return null;
    }
    if (this.busy) return null;

    this.patch({ phase: 'checking', stage: 'CHECKING', error: null });
    const result = await checkForUpdate(this.source, {
      local: this.options.local,
      channel: this.options.channel,
      now: this.options.host.now,
    });

    this.options.host.log(`check: ${describeCheck(result)}`);

    switch (result.status) {
      case 'update-available': {
        if (this.dismissed.isDismissed(result.remote.build)) {
          this.patch({ phase: 'idle', stage: null });
          return result;
        }
        this.manifest = result.remote;
        this.patch({
          phase: 'update-available',
          stage: null,
          available: summariseAvailable(result.remote, result.manifestSource),
        });
        return result;
      }
      case 'unavailable':
        // Soft failure by design: no dialog, no retry storm, no startup impact.
        this.patch({ phase: 'unavailable', stage: null, error: result.reason });
        return result;
      default:
        this.manifest = null;
        this.patch({ phase: 'up-to-date', stage: null, available: null });
        return result;
    }
  }

  /** The owner pressed [Later]: do not prompt again for this build in this session. */
  dismiss(): void {
    if (this.manifest) this.dismissed.dismiss(this.manifest.build);
    this.patch({ phase: 'idle', stage: null });
  }

  /**
   * Copies, verifies, validates and stages the update, then hands over to the detached helper.
   * Returns without resolving when the handover succeeds, because the app is about to exit.
   */
  async install(): Promise<void> {
    if (!this.source) throw new UpdateError('No update source is configured.', 'CHECKING');
    if (!this.manifest) throw new UpdateError('No update is available to install.', 'CHECKING');
    if (this.busy) throw new UpdateError('An update is already in progress.', 'CHECKING');

    const manifest = this.manifest;
    const layout = this.options.layout;
    this.busy = true;
    const startedAt = this.options.host.now?.() ?? Date.now();

    try {
      fs.mkdirSync(layout.downloadDir, { recursive: true });
      fs.mkdirSync(layout.stagingDir, { recursive: true });

      // --- COPYING ---------------------------------------------------------------
      const packageFile = path.join(layout.downloadDir, path.basename(manifest.package));
      this.patch({ phase: 'downloading', stage: 'COPYING', error: null, progress: null });
      this.options.host.log(`copying ${manifest.package} from ${this.source.description}`);
      await this.source.copyPackage(manifest.package, packageFile, (progress) => {
        this.patch({ progress: { ...progress, stage: 'COPYING' } });
      });

      // --- VERIFYING -------------------------------------------------------------
      this.patch({ phase: 'installing', stage: 'VERIFYING', progress: null });
      const actual = sha256File(packageFile, () => undefined);
      if (!digestsMatch(manifest.sha256, actual)) {
        // Integrity failure: delete the download and leave the working runtime alone.
        fs.rmSync(packageFile, { force: true });
        throw new UpdateError(
          `The downloaded package failed its SHA256 check (expected ${manifest.sha256}, found ${actual}).`,
          'VERIFYING',
        );
      }
      const size = fs.statSync(packageFile).size;
      if (size !== manifest.size) {
        fs.rmSync(packageFile, { force: true });
        throw new UpdateError(`The downloaded package is ${size} bytes; the manifest says ${manifest.size}.`, 'VERIFYING');
      }
      this.options.host.log(`verified sha256 ${actual} and size ${size}`);

      // --- VALIDATING ------------------------------------------------------------
      this.patch({ stage: 'VALIDATING' });
      let entries: string[];
      try {
        entries = listZipEntries(packageFile);
      } catch (error) {
        throw new UpdateError(`The update package is not a readable ZIP: ${message(error)}`, 'VALIDATING');
      }
      if (entries.length === 0) throw new UpdateError('The update package is empty.', 'VALIDATING');

      // ZIP-slip: reject before extraction so nothing can be written outside staging.
      try {
        assertSafeEntries(entries);
      } catch (error) {
        throw new UpdateError(`The update package has unsafe paths: ${message(error)}`, 'VALIDATING');
      }

      const inspection = inspectPackageEntries(entries);
      if (!inspection.ok) {
        throw new UpdateError(`The update package failed inspection: ${describeInspection(inspection)}`, 'VALIDATING');
      }
      this.options.host.log(`validated ${inspection.entryCount} entries; Electron markers ${inspection.electronMarkers.join(', ')}`);

      // --- STAGING ---------------------------------------------------------------
      this.patch({ stage: 'STAGING' });
      fs.rmSync(layout.stagingDir, { recursive: true, force: true });
      fs.mkdirSync(layout.stagingDir, { recursive: true });
      try {
        extractZip(packageFile, layout.stagingDir);
      } catch (error) {
        throw new UpdateError(`The update package could not be extracted: ${message(error)}`, 'STAGING');
      }

      // Re-check on disk: the archive listing is not proof the bytes landed.
      for (const entry of REQUIRED_PACKAGE_ENTRIES) {
        const resolved = resolveStagedEntry(layout.stagingDir, entry);
        if (!fs.existsSync(resolved)) {
          throw new UpdateError(`The extracted runtime is missing ${entry}.`, 'STAGING');
        }
      }
      const launcher = resolveStagedEntry(layout.stagingDir, TNP_LAUNCHER_NAME);
      const stagedIdentity = checkPackageIdentity(
        readJson(resolveStagedEntry(layout.stagingDir, 'resources/app/package.json')),
        { hasLauncher: fs.existsSync(launcher), hasElectronMarkers: inspection.electronMarkers.length > 0 },
      );
      if (!stagedIdentity.ok) {
        throw new UpdateError(`The staged runtime is not a valid TNP build: ${stagedIdentity.reasons.join(' ')}`, 'STAGING');
      }

      const stagedVersion = readStagedVersion(layout.stagingDir);
      if (stagedVersion.version !== manifest.version || stagedVersion.build !== manifest.build) {
        throw new UpdateError(
          `The staged runtime is ${describeVersion(stagedVersion)} but the manifest announces `
          + `${describeVersion({ version: manifest.version, build: manifest.build })}.`,
          'STAGING',
        );
      }
      this.options.host.log(`staged ${describeVersion(stagedVersion)} at ${layout.stagingDir}`);

      // --- WAITING_FOR_EXIT ------------------------------------------------------
      const plan = createInstallPlan({
        layout,
        stagedDir: layout.stagingDir,
        previousBuild: this.options.local.build,
        targetBuild: manifest.build,
      });
      const helperPlan: HelperPlan = {
        runtimeRoot: layout.runtimeRoot,
        updateDir: layout.updateDir,
        planFile: layout.planFile,
        stagedDir: layout.stagingDir,
        backupRoot: layout.runtimeBackupDir,
        runtimeEntries: plan.runtimeEntries,
        previousBuild: plan.previousBuild,
        targetBuild: plan.targetBuild,
        waitForPid: this.options.host.pid(),
        waitForExitMs: 30_000,
        relaunchCommand: this.options.host.relaunchCommand(),
        relaunchArgs: this.options.host.relaunchArgs(),
        relaunchCwd: layout.runtimeRoot,
        logFile: layout.updateLogFile,
        resultFile: path.join(layout.updateDir, 'last-update-result.json'),
      };
      fs.writeFileSync(layout.planFile, `${JSON.stringify(helperPlan, null, 2)}\n`, 'utf8');
      fs.writeFileSync(
        path.join(layout.updateDir, 'update-plan.json.meta'),
        `${JSON.stringify({ createdAt: new Date().toISOString(), from: describeVersion(this.options.local), to: describeVersion(stagedVersion) }, null, 2)}\n`,
        'utf8',
      );

      this.patch({ stage: 'WAITING_FOR_EXIT' });
      this.options.host.log(`handing over to the updater helper for build ${manifest.build}`);
      const helperPid = this.options.host.spawnHelper(helperPlan);
      this.options.host.log(`helper pid ${helperPid}; closing TNP`);

      const elapsed = (this.options.host.now?.() ?? Date.now()) - startedAt;
      this.patch({
        phase: 'installing',
        stage: 'INSTALLING',
        progress: {
          bytesTransferred: size,
          totalBytes: size,
          percent: computePercent(size, size),
          transferRate: elapsed > 0 ? Math.round((size / (elapsed / 1000))) : 0,
          stage: 'INSTALLING',
        },
      });
      this.options.host.quit(`Updating to build ${manifest.build}.`);
      // Never cleared: the process is exiting.
    } catch (error) {
      const stage = error instanceof UpdateError ? error.stage : 'FAILED';
      const text = message(error);
      this.options.host.log(`update failed at ${stage}: ${text}`);
      this.patch({ phase: 'failed', stage: 'FAILED', error: text, progress: null });
      // Leave the running runtime exactly as it is.
      this.busy = false;
      throw error instanceof UpdateError ? error : new UpdateError(text, stage);
    }
  }

  /** Removes the working area; never touches production directories. */
  cleanWorkingArea(): void {
    for (const dir of [this.options.layout.downloadDir, this.options.layout.stagingDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (!fs.existsSync(this.options.layout.updateDir)) return;
    if (fs.readdirSync(this.options.layout.updateDir).length === 0) {
      fs.rmSync(this.options.layout.updateDir, { recursive: true, force: true });
    }
  }

  private patch(change: Partial<UpdateState>): void {
    this.state = { ...this.state, ...change };
    this.options.host.emit(this.state);
  }
}

export function summariseAvailable(manifest: UpdateManifest, source: string): AvailableUpdateSummary {
  return {
    version: manifest.version,
    build: manifest.build,
    publishedAt: manifest.publishedAt,
    releaseNotes: manifest.releaseNotes ?? null,
    size: manifest.size,
    package: manifest.package,
    source,
  };
}

export function describeCheck(result: UpdateCheckResult): string {
  switch (result.status) {
    case 'update-available':
      return `update available, build ${result.remote.build} (local ${result.local.build})`;
    case 'unavailable':
      return `unavailable — ${result.reason}`;
    case 'same-build':
      return `already on build ${result.local.build}`;
    case 'older-remote':
      return `the source publishes build ${result.remote?.build}, which is older than local ${result.local.build}`;
    default:
      return 'up to date';
  }
}

function readStagedVersion(stagingRoot: string): AppVersion {
  const parsed = readJson(resolveStagedEntry(stagingRoot, 'resources/app/package.json')) as
    { version?: unknown; tnpBuild?: unknown };
  const version = typeof parsed.version === 'string' ? parsed.version : '';
  const build = Number(parsed.tnpBuild);
  if (!version || !Number.isInteger(build)) {
    throw new UpdateError('The staged runtime has no usable version or build number.', 'STAGING');
  }
  return { version, build };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
