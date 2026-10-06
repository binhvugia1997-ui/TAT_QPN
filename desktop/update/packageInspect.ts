/**
 * The runtime-only package contract.
 *
 * An update package carries *application runtime* and nothing else. Production state must
 * never travel in an update: if `data/`, `backups/` or `reports/` were bundled, installing an
 * update would overwrite the owner's live database with whatever the build machine had. That
 * is the single most dangerous thing this feature could do, so it is enforced here, in the
 * publisher before it publishes, and again on the Owner PC before it installs.
 */
import * as path from 'node:path';
import { PERSISTENT_DIR_NAMES, UPDATE_DIR_NAME } from './layout';
import { EXPECTED_ARCHITECTURE, EXPECTED_PRODUCT } from './manifest';

export const TNP_LAUNCHER_NAME = 'TNP Defect Management TEST.exe';

/** Relative package paths that must never appear in an update. */
export const FORBIDDEN_PACKAGE_PATHS = [
  'data',
  'backups',
  'reports',
  UPDATE_DIR_NAME,
  '.git',
  'node_modules',
  '.cache',
  'artifacts',
  'coverage',
] as const;

/** File names that must never appear anywhere in an update package. */
export const FORBIDDEN_PACKAGE_FILES = [
  'tnp.db',
  'tnp.db-wal',
  'tnp.db-shm',
  'tnp.lock',
  'desktop-settings.json',
  'server.log',
  'desktop-diagnostic.log',
  'update.log',
  'EXCEL_EXPORT_FILE_20261002181424.xlsx',
] as const;

/** Files that must be present for the package to be a TNP runtime at all. */
export const REQUIRED_PACKAGE_ENTRIES = [
  TNP_LAUNCHER_NAME,
  'resources/app/package.json',
  'resources/app/dist/desktop/main/main.js',
  'resources/app/dist/desktop/preload/preload.js',
  'resources/app/dist/server/startupSignals.js',
  'resources/app/server-runtime/server/index.js',
  'resources/app/server-runtime/package.json',
  'resources/app/seed/legacy-base-data.json',
  'resources/app/web/index.html',
  'resources/app/dist/desktop/update/helperMain.js',
] as const;

/** Markers that this really is a Windows x64 Electron runtime. */
export const ELECTRON_RUNTIME_MARKERS = ['ffmpeg.dll', 'libEGL.dll', 'v8_context_snapshot.bin'] as const;

export interface PackageInspection {
  ok: boolean;
  forbidden: string[];
  missing: string[];
  /** Present markers proving the Electron runtime is included. */
  electronMarkers: string[];
  entryCount: number;
}

function normalize(entry: string): string {
  return entry.replace(/\\/gu, '/').replace(/^\.\/+/u, '').replace(/\/+$/u, '');
}

function segments(entry: string): string[] {
  return normalize(entry).split('/').filter((segment) => segment.length > 0);
}

export function isForbiddenPackageEntry(entry: string): string | null {
  const parts = segments(entry);
  if (parts.length === 0) return null;

  for (const forbidden of FORBIDDEN_PACKAGE_PATHS) {
    if (parts.includes(forbidden)) return forbidden;
  }
  const base = parts[parts.length - 1] as string;
  if ((FORBIDDEN_PACKAGE_FILES as readonly string[]).includes(base)) return base;
  return null;
}

/**
 * Inspects a package's entry list. `entries` comes from the ZIP central directory, so this runs
 * before anything is extracted.
 */
export function inspectPackageEntries(entries: readonly string[]): PackageInspection {
  const normalized = entries.map(normalize).filter((entry) => entry.length > 0);

  const forbidden = new Set<string>();
  for (const entry of entries) {
    const hit = isForbiddenPackageEntry(entry);
    if (hit) forbidden.add(`${hit} (from "${normalize(entry)}")`);
  }

  const present = new Set(normalized);
  const missing = (REQUIRED_PACKAGE_ENTRIES as readonly string[]).filter((entry) => !present.has(entry));

  const electronMarkers = (ELECTRON_RUNTIME_MARKERS as readonly string[])
    .filter((marker) => present.has(marker));

  return {
    ok: forbidden.size === 0 && missing.length === 0,
    forbidden: [...forbidden],
    missing,
    electronMarkers,
    entryCount: normalized.length,
  };
}

export function describeInspection(inspection: PackageInspection): string {
  const parts: string[] = [];
  if (inspection.forbidden.length > 0) {
    parts.push(`forbidden production content: ${inspection.forbidden.join(', ')}`);
  }
  if (inspection.missing.length > 0) {
    parts.push(`missing runtime files: ${inspection.missing.join(', ')}`);
  }
  return parts.length > 0 ? parts.join('; ') : 'ok';
}

export interface IdentityCheck {
  ok: boolean;
  product: string | null;
  architecture: string | null;
  reasons: string[];
}

/**
 * Confirms the extracted runtime really is TNP for win-x64, using the packaged manifest rather
 * than trusting the folder name.
 */
export function checkPackageIdentity(
  appPackageJson: unknown,
  options: { hasLauncher: boolean; hasElectronMarkers: boolean },
): IdentityCheck {
  const reasons: string[] = [];
  const manifest = (typeof appPackageJson === 'object' && appPackageJson !== null ? appPackageJson : {}) as
    Record<string, unknown>;

  const product = typeof manifest.productName === 'string' ? manifest.productName : null;
  if (product !== `${EXPECTED_PRODUCT} — TEST (portable)` && product !== EXPECTED_PRODUCT && product !== 'TNP Defect Management TEST') {
    reasons.push(`The packaged product name "${String(product)}" is not a TNP runtime.`);
  }
  if (manifest.name !== 'tnp-defect-management-test') {
    reasons.push(`The packaged name "${String(manifest.name)}" is not tnp-defect-management-test.`);
  }
  if (!options.hasLauncher) reasons.push(`The launcher "${TNP_LAUNCHER_NAME}" is missing.`);
  if (!options.hasElectronMarkers) reasons.push('The Electron runtime files are missing.');

  return {
    ok: reasons.length === 0,
    product,
    architecture: EXPECTED_ARCHITECTURE,
    reasons,
  };
}

/** True when a relative package entry lives under a persistent directory. */
export function isPersistentPackageEntry(entry: string): boolean {
  const parts = segments(entry);
  return parts.length > 0 && (PERSISTENT_DIR_NAMES as readonly string[]).includes(parts[0] as string);
}

/** Joins a package entry onto a staging root, refusing anything that would escape it. */
export function resolveStagedEntry(stagingRoot: string, entry: string): string {
  const normalized = normalize(entry);
  const resolved = path.resolve(stagingRoot, normalized);
  const relative = path.relative(path.resolve(stagingRoot), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`The package entry "${entry}" escapes the staging directory.`);
  }
  return resolved;
}
