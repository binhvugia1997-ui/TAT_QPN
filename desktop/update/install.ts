/**
 * Runtime replacement with a rollback copy.
 *
 * Two different backups exist in this product and they must never be confused:
 *
 *   A. SQLite data backups  — `backups/`, produced by the server's BackupService. Production
 *      data. Never touched by the updater.
 *   B. Runtime rollback copy — `.tnp-update/runtime-backup/`, produced here. A copy of the
 *      *application* (exe, Electron libraries, resources/app) so a failed install can be
 *      reverted. Contains no production data at all.
 *
 * A failed runtime install therefore rolls the *application* back and leaves `data/tnp.db`
 * exactly as it is. Rolling the database back because a runtime swap failed would destroy
 * real work, so nothing here ever restores a database.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  UPDATE_DIR_NAME,
  assertNotPreserved,
  isPreserved,
  runtimeBackupFolderName,
  runtimeEntryNames,
} from './layout';
import type { UpdateLayout } from './layout';

export interface InstallPlan {
  runtimeRoot: string;
  updateDir: string;
  /** Validated, extracted candidate runtime. */
  stagedDir: string;
  /** Where the current runtime is copied before it is replaced. */
  backupDir: string;
  /** Top-level entries that make up the runtime and will be replaced. */
  runtimeEntries: string[];
  previousBuild: number;
  targetBuild: number;
  createdAt: string;
}

export interface StepResult {
  ok: boolean;
  message: string;
  entriesProcessed: number;
  bytesCopied?: number;
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

export function createInstallPlan(input: {
  layout: UpdateLayout;
  stagedDir: string;
  previousBuild: number;
  targetBuild: number;
  when?: Date;
}): InstallPlan {
  const { layout, stagedDir, previousBuild, targetBuild } = input;
  if (!fs.existsSync(stagedDir) || !fs.statSync(stagedDir).isDirectory()) {
    throw new InstallError(`The staged runtime "${stagedDir}" does not exist.`);
  }

  const currentEntries = listTopLevel(layout.runtimeRoot);
  const runtimeEntries = runtimeEntryNames(currentEntries, layout);
  if (runtimeEntries.length === 0) {
    throw new InstallError(`No runtime entries were found in "${layout.runtimeRoot}".`);
  }

  // Refuse to plan anything that would touch production state, before any fs write happens.
  for (const entry of runtimeEntries) {
    assertNotPreserved(path.join(layout.runtimeRoot, entry), layout, 'replace');
  }

  return {
    runtimeRoot: layout.runtimeRoot,
    updateDir: layout.updateDir,
    stagedDir: path.resolve(stagedDir),
    backupDir: path.join(layout.runtimeBackupDir, runtimeBackupFolderName(targetBuild, input.when ?? new Date())),
    runtimeEntries,
    previousBuild,
    targetBuild,
    createdAt: new Date().toISOString(),
  };
}

/** Copies the current runtime aside. Excludes every persistent directory by construction. */
export function backupRuntime(plan: InstallPlan, layout: UpdateLayout): StepResult {
  fs.mkdirSync(plan.backupDir, { recursive: true });
  let entries = 0;
  for (const entry of plan.runtimeEntries) {
    const source = path.join(plan.runtimeRoot, entry);
    assertNotPreserved(source, layout, 'back up');
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(plan.backupDir, entry), { recursive: true, dereference: false });
    entries += 1;
  }

  fs.writeFileSync(
    path.join(plan.backupDir, 'runtime-backup.json'),
    `${JSON.stringify(
      { kind: 'runtime-rollback', previousBuild: plan.previousBuild, targetBuild: plan.targetBuild, createdAt: plan.createdAt },
      null,
      2,
    )}\n`,
  );

  if (entries === 0) {
    return { ok: false, message: 'Nothing was backed up; refusing to continue.', entriesProcessed: 0 };
  }
  return { ok: true, message: `Backed up ${entries} runtime entr${entries === 1 ? 'y' : 'ies'}.`, entriesProcessed: entries };
}

/** Replaces the runtime from the staged copy. Production directories are never enumerated. */
export function applyRuntime(plan: InstallPlan, layout: UpdateLayout): StepResult {
  const stagedEntries = listTopLevel(plan.stagedDir);
  if (stagedEntries.length === 0) {
    throw new InstallError('The staged runtime is empty; refusing to install it.');
  }
  for (const entry of stagedEntries) {
    if (isPreserved(path.join(plan.runtimeRoot, entry), layout)) {
      throw new InstallError(`The staged runtime contains "${entry}", which is production data.`);
    }
  }

  let processed = 0;
  for (const entry of plan.runtimeEntries) {
    const target = path.join(plan.runtimeRoot, entry);
    assertNotPreserved(target, layout, 'replace');
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    processed += 1;
  }
  for (const entry of stagedEntries) {
    const destination = path.join(plan.runtimeRoot, entry);
    assertNotPreserved(destination, layout, 'write');
    fs.cpSync(path.join(plan.stagedDir, entry), destination, { recursive: true });
    processed += 1;
  }

  return { ok: true, message: `Replaced the runtime (${processed} operations).`, entriesProcessed: processed };
}

/** Restores the runtime backup. Never touches production data. */
export function rollbackRuntime(plan: InstallPlan, layout: UpdateLayout): StepResult {
  if (!fs.existsSync(plan.backupDir)) {
    return { ok: false, message: `No runtime backup exists at ${plan.backupDir}.`, entriesProcessed: 0 };
  }

  const backedUp = listTopLevel(plan.backupDir).filter((entry) => entry !== 'runtime-backup.json');
  if (backedUp.length === 0) {
    return { ok: false, message: 'The runtime backup is empty.', entriesProcessed: 0 };
  }

  let processed = 0;
  for (const entry of listTopLevel(plan.runtimeRoot)) {
    const target = path.join(plan.runtimeRoot, entry);
    if (isPreserved(target, layout) || entry === UPDATE_DIR_NAME) continue;
    assertNotPreserved(target, layout, 'remove during rollback');
    fs.rmSync(target, { recursive: true, force: true });
    processed += 1;
  }
  for (const entry of backedUp) {
    const destination = path.join(plan.runtimeRoot, entry);
    assertNotPreserved(destination, layout, 'restore during rollback');
    fs.cpSync(path.join(plan.backupDir, entry), destination, { recursive: true });
    processed += 1;
  }

  return { ok: true, message: `Restored the previous runtime (${processed} operations).`, entriesProcessed: processed };
}

/**
 * Verifies the preservation contract after an install or rollback: the persistent directories
 * must still be exactly where they were.
 */
export function verifyPreserved(layout: UpdateLayout): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const preserved of layout.preservedDirs) {
    if (!fs.existsSync(preserved)) missing.push(preserved);
  }
  return { ok: missing.length === 0, missing };
}

function listTopLevel(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}
