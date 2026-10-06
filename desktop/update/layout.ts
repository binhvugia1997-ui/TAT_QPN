/**
 * The update preservation contract.
 *
 * The Owner PC keeps its production data in `data/`, `backups/` and `reports/` **inside** the
 * portable folder. An update replaces the *application runtime* — the executable, the Electron
 * libraries and `resources/app` — and must leave those three directories byte-for-byte alone.
 *
 * Everything the updater writes for itself lives in `.tnp-update/`, which is likewise never
 * replaced and never bundled into an update package.
 */
import * as path from 'node:path';

/** Working area for downloads, staging, runtime backups and the updater log. */
export const UPDATE_DIR_NAME = '.tnp-update';

/** Production state that survives every software update. */
export const PERSISTENT_DIR_NAMES = ['data', 'backups', 'reports'] as const;

export type PersistentDirName = (typeof PERSISTENT_DIR_NAMES)[number];

/** Key production files, called out because their loss would be catastrophic. */
export const CRITICAL_PERSISTENT_FILES = [
  'data/tnp.db',
  'data/desktop-settings.json',
] as const;

export interface UpdateLayoutInput {
  /** The portable folder: exe, dlls and resources/app live here. */
  runtimeRoot: string;
  dataDir: string;
  backupsDir: string;
  reportsDir: string;
}

export interface UpdateLayout {
  runtimeRoot: string;
  updateDir: string;
  /** Where a package is copied to before it is verified. */
  downloadDir: string;
  /** Where a verified package is extracted. */
  stagingDir: string;
  /** Rollback copies of the *runtime* only — never SQLite backups. */
  runtimeBackupDir: string;
  /** Plan handed to the standalone updater helper. */
  planFile: string;
  updateLogFile: string;
  /** Absolute paths that must never be replaced, moved or deleted. */
  preservedDirs: readonly string[];
}

export function resolveUpdateLayout(input: UpdateLayoutInput): UpdateLayout {
  const runtimeRoot = path.resolve(input.runtimeRoot);
  const updateDir = path.join(runtimeRoot, UPDATE_DIR_NAME);
  return {
    runtimeRoot,
    updateDir,
    downloadDir: path.join(updateDir, 'download'),
    stagingDir: path.join(updateDir, 'staging'),
    runtimeBackupDir: path.join(updateDir, 'runtime-backup'),
    planFile: path.join(updateDir, 'update-plan.json'),
    updateLogFile: path.join(updateDir, 'update.log'),
    preservedDirs: [
      path.resolve(input.dataDir),
      path.resolve(input.backupsDir),
      path.resolve(input.reportsDir),
      updateDir,
    ],
  };
}

/** True when `candidate` is, or lives inside, one of the preserved directories. */
export function isPreserved(candidate: string, layout: UpdateLayout): boolean {
  const resolved = path.resolve(candidate);
  return layout.preservedDirs.some((preserved) => {
    const relative = path.relative(preserved, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

/** Throws if an operation would touch production state. */
export function assertNotPreserved(candidate: string, layout: UpdateLayout, operation: string): void {
  if (isPreserved(candidate, layout)) {
    throw new Error(
      `Refusing to ${operation} "${candidate}": it is production data and survives every update.`,
    );
  }
}

/**
 * The relative top-level entries that make up the runtime, i.e. everything an update replaces.
 * Persistent directories and the updater's own working area are excluded.
 */
export function runtimeEntryNames(
  entries: readonly string[],
  layout: UpdateLayout,
): string[] {
  return entries.filter((name) => {
    if (PERSISTENT_DIR_NAMES.includes(name as PersistentDirName)) return false;
    if (name === UPDATE_DIR_NAME) return false;
    return !isPreserved(path.join(layout.runtimeRoot, name), layout);
  });
}

/** A runtime backup name that cannot collide and cannot traverse. */
export function runtimeBackupFolderName(build: number, when: Date = new Date()): string {
  const stamp = [
    when.getUTCFullYear(),
    `${when.getUTCMonth() + 1}`.padStart(2, '0'),
    `${when.getUTCDate()}`.padStart(2, '0'),
    '-',
    `${when.getUTCHours()}`.padStart(2, '0'),
    `${when.getUTCMinutes()}`.padStart(2, '0'),
    `${when.getUTCSeconds()}`.padStart(2, '0'),
  ].join('');
  const safeBuild = Number.isInteger(build) && build > 0 ? build : 0;
  return `runtime-${stamp}-build${safeBuild}`;
}
