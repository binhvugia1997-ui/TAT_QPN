/**
 * Portable layout resolution for the Windows TEST build.
 *
 * The owner runs this from a plain folder (Desktop / USB stick / network share) with no
 * installer, so nothing may assume an installed app location or a writable install
 * directory. The rules are:
 *
 * 1. An explicit `TNP_DATA_ROOT` always wins (used by dev, tests and troubleshooting).
 * 2. Otherwise the data root is the folder holding the executable, but **only if it is
 *    actually writable** — a read-only share or `Program Files` must not produce a crash.
 * 3. Otherwise it falls back to the per-user app-data folder, and the UI is told about it.
 *
 * `data/`, `backups/` and `reports/` all live under that root, next to each other, so a
 * copy of the whole folder is a complete backup of the TEST dataset. This module touches
 * no Electron API so it can be unit tested directly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LayoutProbe {
  /** Returns true when a directory can be created and written into. Never throws. */
  isWritableDirectory(candidate: string): boolean;
}

export const realProbe: LayoutProbe = {
  isWritableDirectory(candidate: string): boolean {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const probe = path.join(candidate, `.tnp-write-probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.rmSync(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  },
};

export interface PortableLayoutInput {
  /** Folder containing the executable (portable candidate root). */
  executableDir: string;
  /** Per-user app-data folder, the fallback root. */
  userDataDir: string;
  /** Folder holding the bundled server + web assets (`process.resourcesPath`/app). */
  appDir: string;
  env?: Record<string, string | undefined>;
  probe?: LayoutProbe;
}

export interface PortableLayout {
  /** Where `data/`, `backups/` and `reports/` live. */
  root: string;
  dataDir: string;
  backupsDir: string;
  reportsDir: string;
  databaseFile: string;
  lockFile: string;
  settingsFile: string;
  seedFile: string;
  serverEntry: string;
  staticDir: string;
  logFile: string;
  /** False when the portable root was rejected and the per-user fallback was used. */
  portable: boolean;
  /** Human-readable reason, surfaced in the desktop status panel. */
  rootNote: string;
}

/** Names of the three owner-visible folders; kept identical to the Phase 5 server layout. */
export const DATA_DIR_NAME = 'data';
export const BACKUPS_DIR_NAME = 'backups';
export const REPORTS_DIR_NAME = 'reports';

export function resolvePortableLayout(input: PortableLayoutInput): PortableLayout {
  const env = input.env ?? {};
  const probe = input.probe ?? realProbe;

  const explicit = env.TNP_DATA_ROOT?.trim();
  let root: string;
  let portable: boolean;
  let rootNote: string;

  if (explicit) {
    root = explicit;
    portable = false;
    rootNote = `Using the folder set by TNP_DATA_ROOT: ${explicit}`;
  } else if (probe.isWritableDirectory(input.executableDir)) {
    root = input.executableDir;
    portable = true;
    rootNote = 'Portable mode: data, backups and reports are stored next to the app.';
  } else {
    root = input.userDataDir;
    portable = false;
    rootNote =
      `The app folder is not writable (${input.executableDir}), so data is stored per user at `
      + `${input.userDataDir}. Copy the app folder somewhere writable to keep data beside it.`;
  }

  const dataDir = env.TNP_DATA_DIR?.trim() || path.join(root, DATA_DIR_NAME);
  const backupsDir = env.TNP_BACKUPS_DIR?.trim() || path.join(root, BACKUPS_DIR_NAME);
  const reportsDir = env.TNP_REPORTS_DIR?.trim() || path.join(root, REPORTS_DIR_NAME);

  return {
    root,
    dataDir,
    backupsDir,
    reportsDir,
    databaseFile: path.join(dataDir, 'tnp.db'),
    lockFile: path.join(dataDir, 'tnp.lock'),
    settingsFile: path.join(dataDir, 'desktop-settings.json'),
    seedFile: resolveSeedFile(input.appDir, env),
    serverEntry: resolveServerEntry(input.appDir, env),
    staticDir: resolveStaticDir(input.appDir, env),
    logFile: path.join(dataDir, 'server.log'),
    portable,
    rootNote,
  };
}

/** Packaged seed first, then the repository copy for dev runs. */
function resolveSeedFile(appDir: string, env: Record<string, string | undefined>): string {
  return env.TNP_SEED_FILE?.trim()
    || firstExisting(
      path.join(appDir, 'seed', 'legacy-base-data.json'),
      path.join(process.cwd(), 'src', 'data', 'legacy-base-data.json'),
    );
}

function resolveServerEntry(appDir: string, env: Record<string, string | undefined>): string {
  return env.TNP_SERVER_ENTRY?.trim()
    || firstExisting(
      // Packaged layout: resources/app/server-runtime/server/index.js
      path.join(appDir, 'server-runtime', 'server', 'index.js'),
      path.join(process.cwd(), 'dist-server', 'server', 'index.js'),
    );
}

function resolveStaticDir(appDir: string, env: Record<string, string | undefined>): string {
  return env.TNP_STATIC_DIR?.trim()
    || firstExistingDirectory(
      path.join(appDir, 'web'),
      path.join(process.cwd(), 'dist'),
    );
}

function firstExisting(...candidates: readonly string[]): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] as string;
}

function firstExistingDirectory(...candidates: readonly string[]): string {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Candidate does not exist; try the next one.
    }
  }
  return candidates[0] as string;
}

/**
 * Refuses anything that is not a plausible portable root. Guards against an empty or
 * filesystem-root value silently taking over the owner's disk.
 */
export function assertUsableRoot(candidate: string): void {
  const trimmed = candidate?.trim();
  if (!trimmed) throw new Error('The data root folder is empty.');
  const resolved = path.resolve(trimmed);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    throw new Error(`Refusing to use a filesystem root as the data folder: ${resolved}`);
  }
  if (resolved.length < 2) throw new Error(`Refusing to use a suspicious data folder: ${resolved}`);
}
