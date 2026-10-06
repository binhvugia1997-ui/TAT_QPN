/**
 * The TEST update publisher, run on the build/test machine only.
 *
 *   node dist-desktop/desktop/update/publish.js --source <portable folder> --target <LAN folder>
 *
 * Publication order is mandatory and is enforced by the sequence below:
 *
 *   runtime-only package  →  inspect  →  sha256  →  copy to a temporary name
 *   →  verify destination size  →  verify destination sha256  →  atomic rename
 *   →  write version.json.tmp  →  atomic replace version.json LAST
 *
 * A client that reads `version.json` therefore can never be pointed at a package that is not
 * already fully present and verified. If anything fails before the manifest is replaced, the
 * previously published manifest stays valid and current.
 *
 * The build machine's own SQLite database, reports and backups are TEST DATA and are excluded
 * from the package by construction — see `collectRuntimeForPackage`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createZip, listZipEntries } from './archive';
import { sha256File } from './hash';
import {
  PERSISTENT_DIR_NAMES,
  UPDATE_DIR_NAME,
} from './layout';
import {
  EXPECTED_ARCHITECTURE,
  EXPECTED_PRODUCT,
  MANIFEST_FILENAME,
  TEST_CHANNEL,
  assertSafePackageFileName,
  parseManifest,
  serializeManifest,
} from './manifest';
import type { UpdateManifest } from './manifest';
import {
  describeInspection,
  inspectPackageEntries,
  isForbiddenPackageEntry,
} from './packageInspect';

export interface PublishInput {
  /** The assembled portable folder. */
  sourceDir: string;
  /** LAN folder that clients read from. */
  targetDir: string;
  version: string;
  build: number;
  channel: string;
  releaseNotes?: string;
  /** Package file name; defaults to a build-derived safe name. */
  packageName?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface PublishResult {
  ok: boolean;
  manifest: UpdateManifest | null;
  packagePath: string | null;
  sha256: string | null;
  size: number;
  message: string;
  /** Steps completed, in order — useful for proving the manifest went last. */
  steps: string[];
}

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

const TEMP_SUFFIX = '.tmp';
const STALE_TEMP_MS = 6 * 60 * 60 * 1000;

/**
 * Neutralises a value before it is used in a file name. Collapsing dot runs and stripping
 * leading dots matters: a name containing `..` is rejected by the client even when it is not
 * actually a traversal, so the publisher must never generate one.
 */
function sanitizeNamePart(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]/gu, '-')
    .replace(/\.{2,}/gu, '.')
    .replace(/^\.+|\.+$/gu, '')
    .replace(/\.{2,}/gu, '.')
    .slice(0, 60) || 'x';
}

export function defaultPackageName(version: string, build: number, channel: string): string {
  return `tnp-${sanitizeNamePart(channel.toLowerCase())}-${sanitizeNamePart(version)}-build${build}-win-x64.zip`;
}

/**
 * Validates the name a package will be written under. This is what stops a caller-supplied name
 * such as `../escape.zip` from being written outside the update share.
 */
export function assertPublishablePackageName(value: string, targetDir: string): string {
  let safe: string;
  try {
    safe = assertSafePackageFileName(value);
  } catch (error) {
    throw new PublishError(
      `Refusing to publish a package named "${value}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isForbiddenPackageEntry(safe)) {
    throw new PublishError(`Refusing to publish a package named "${value}".`);
  }
  const resolved = path.resolve(targetDir, safe);
  if (path.relative(path.resolve(targetDir), resolved) !== safe) {
    throw new PublishError(`Refusing to publish "${value}" outside the update folder.`);
  }
  return safe;
}

/**
 * Copies only runtime entries into `destination`. Persistent directories and the updater's own
 * working area are skipped by name, so production state cannot leak into a package even if it
 * is sitting in the portable folder on the build machine.
 */
export function collectRuntimeForPackage(sourceDir: string, destination: string): string[] {
  if (!fs.existsSync(sourceDir)) throw new PublishError(`The source folder "${sourceDir}" does not exist.`);
  fs.mkdirSync(destination, { recursive: true });

  const copied: string[] = [];
  for (const entry of fs.readdirSync(sourceDir)) {
    if ((PERSISTENT_DIR_NAMES as readonly string[]).includes(entry)) continue;
    if (entry === UPDATE_DIR_NAME) continue;
    if (entry.startsWith('.git')) continue;
    fs.cpSync(path.join(sourceDir, entry), path.join(destination, entry), { recursive: true });
    copied.push(entry);
  }
  if (copied.length === 0) throw new PublishError('The source folder contains no runtime content.');
  return copied;
}

export async function publishUpdate(input: PublishInput): Promise<PublishResult> {
  const log = input.log ?? (() => undefined);
  const steps: string[] = [];
  const now = input.now ?? (() => new Date());

  if (!Number.isInteger(input.build) || input.build <= 0) {
    throw new PublishError('The build number must be a positive integer.');
  }
  if (!/^[a-z0-9-]{1,32}$/u.test(input.channel)) {
    throw new PublishError(`The channel "${input.channel}" is not a valid channel identifier.`);
  }

  fs.mkdirSync(input.targetDir, { recursive: true });
  cleanStaleTempFiles(input.targetDir, now().getTime(), log);

  const requestedName = input.packageName ?? defaultPackageName(input.version, input.build, input.channel);
  const packageName = assertPublishablePackageName(requestedName, input.targetDir);

  // Gate: never republish an equal or older build over a newer published one.
  const existing = readExistingManifest(input.targetDir);
  if (existing && existing.build >= input.build) {
    throw new PublishError(
      `The update source already publishes build ${existing.build}; refusing to publish build ${input.build}.`,
    );
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnp-publish-'));
  try {
    const packageRoot = path.join(workDir, 'package');
    log('collecting the runtime-only package…');
    const entries = collectRuntimeForPackage(input.sourceDir, packageRoot);
    steps.push('collect-runtime');
    log(`  ${entries.length} runtime entr${entries.length === 1 ? 'y' : 'ies'}`);

    // Inspect the tree before zipping, and again from the archive's central directory.
    const treeEntries = listFilesRelative(packageRoot);
    const treeInspection = inspectPackageEntries(treeEntries);
    if (!treeInspection.ok) {
      throw new PublishError(`The package is not runtime-only: ${describeInspection(treeInspection)}`);
    }
    steps.push('inspect-tree');

    const zipPath = path.join(workDir, packageName);
    log('creating the update package…');
    createZip(packageRoot, zipPath);
    steps.push('create-zip');

    const zipEntries = listZipEntries(zipPath);
    const zipInspection = inspectPackageEntries(zipEntries);
    if (!zipInspection.ok) {
      throw new PublishError(`The packaged archive is not runtime-only: ${describeInspection(zipInspection)}`);
    }
    if (zipInspection.entryCount === 0) throw new PublishError('The update package is empty.');
    steps.push('inspect-archive');
    log(`  ${zipInspection.entryCount} archive entries; ${zipInspection.electronMarkers.length} Electron markers`);

    const size = fs.statSync(zipPath).size;
    const sha256 = sha256File(zipPath);
    steps.push('sha256');
    log(`  size ${size} bytes, sha256 ${sha256}`);

    const manifest: UpdateManifest = {
      product: EXPECTED_PRODUCT,
      channel: input.channel,
      version: input.version,
      build: input.build,
      architecture: EXPECTED_ARCHITECTURE,
      package: packageName,
      sha256,
      size,
      publishedAt: now().toISOString(),
      ...(input.releaseNotes ? { releaseNotes: input.releaseNotes } : {}),
    };

    // Copy under a temporary name, then verify, then rename. Clients never see a partial file.
    const finalPath = path.join(input.targetDir, packageName);
    const tempPath = `${finalPath}${TEMP_SUFFIX}`;
    log(`copying to ${tempPath}`);
    fs.copyFileSync(zipPath, tempPath);
    steps.push('copy-temp-package');

    const copiedSize = fs.statSync(tempPath).size;
    if (copiedSize !== size) {
      fs.rmSync(tempPath, { force: true });
      throw new PublishError(`The destination size ${copiedSize} does not match the package size ${size}.`);
    }
    steps.push('verify-destination-size');

    const copiedSha = sha256File(tempPath);
    if (copiedSha !== sha256) {
      fs.rmSync(tempPath, { force: true });
      throw new PublishError(`The destination sha256 ${copiedSha} does not match ${sha256}.`);
    }
    steps.push('verify-destination-sha256');

    if (fs.existsSync(finalPath)) fs.rmSync(finalPath, { force: true });
    fs.renameSync(tempPath, finalPath);
    steps.push('rename-package');
    log(`published package ${finalPath}`);

    // The manifest is written last, and atomically, so a reader never sees a half-written file
    // or a manifest that points at a package that is not there yet.
    const manifestPath = path.join(input.targetDir, MANIFEST_FILENAME);
    const manifestTemp = `${manifestPath}${TEMP_SUFFIX}`;
    fs.writeFileSync(manifestTemp, serializeManifest(manifest), 'utf8');
    steps.push('write-manifest-temp');
    if (fs.existsSync(manifestPath)) fs.rmSync(manifestPath, { force: true });
    fs.renameSync(manifestTemp, manifestPath);
    steps.push('replace-manifest-last');
    log(`published manifest ${manifestPath}`);

    // Sanity: what we just published must parse and describe the package we shipped.
    const reparsed = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
    if (reparsed.sha256 !== sha256 || reparsed.package !== packageName) {
      throw new PublishError('The published manifest does not describe the published package.');
    }
    steps.push('verify-published-manifest');

    return { ok: true, manifest, packagePath: finalPath, sha256, size, message: 'Published.', steps };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function readExistingManifest(targetDir: string): UpdateManifest | null {
  try {
    return parseManifest(fs.readFileSync(path.join(targetDir, MANIFEST_FILENAME), 'utf8'));
  } catch {
    return null;
  }
}

/** Removes abandoned `.tmp` files from earlier failed runs; never touches real packages. */
export function cleanStaleTempFiles(targetDir: string, nowMs: number, log: (line: string) => void = () => undefined): string[] {
  const removed: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(targetDir);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.endsWith(TEMP_SUFFIX)) continue;
    const full = path.join(targetDir, entry);
    try {
      const stats = fs.statSync(full);
      if (nowMs - stats.mtimeMs > STALE_TEMP_MS) {
        fs.rmSync(full, { force: true });
        removed.push(entry);
        log(`removed stale temporary file ${entry}`);
      }
    } catch {
      // Ignore unreadable entries.
    }
  }
  return removed;
}

function listFilesRelative(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRelative(root, relative));
    else out.push(relative);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Command line entry point (build/test machine only)
 * ------------------------------------------------------------------ */

export interface PublishCliOptions {
  sourceDir: string;
  targetDir: string;
  channel: string;
  releaseNotes?: string;
  packageName?: string;
}

export function parsePublishArgs(argv: readonly string[]): PublishCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      values.set(token.slice(2), String(argv[index + 1] ?? ''));
      index += 1;
    }
  }
  const sourceDir = values.get('source') ?? '';
  const targetDir = values.get('target') ?? '';
  if (!sourceDir || !targetDir) {
    throw new PublishError('Usage: publish.js --source <portable folder> --target <LAN folder> [--channel test] [--notes "..."] [--package name.zip]');
  }
  return {
    sourceDir,
    targetDir,
    // TEST is the only channel this tool publishes by default; a production manifest is a
    // separate folder and a separate, deliberate action.
    channel: (values.get('channel') ?? TEST_CHANNEL).trim().toLowerCase(),
    releaseNotes: values.get('notes'),
    packageName: values.get('package'),
  };
}

/** Reads the authoritative version and build from the application's package.json. */
export function readAppVersionFile(packageJsonPath: string): { version: string; build: number } {
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown; tnpBuild?: unknown };
  const version = typeof parsed.version === 'string' ? parsed.version : '';
  const build = Number(parsed.tnpBuild);
  if (!version) throw new PublishError(`${packageJsonPath} has no version.`);
  if (!Number.isInteger(build) || build <= 0) throw new PublishError(`${packageJsonPath} has no positive integer tnpBuild.`);
  return { version, build };
}

if (require.main === module) {
  const log = (line: string): void => { process.stdout.write(`[publish] ${line}\n`); };
  try {
    const options = parsePublishArgs(process.argv.slice(2));
    const { version, build } = readAppVersionFile(path.resolve(__dirname, '../../../package.json'));
    void publishUpdate({ ...options, version, build, log }).then((result) => {
      if (!result.ok) {
        process.stderr.write(`[publish] FAILED: ${result.message}\n`);
        process.exitCode = 1;
        return;
      }
      log(`done: ${result.manifest?.product} ${result.manifest?.version} build ${result.manifest?.build} → ${result.packagePath}`);
      log(`sha256 ${result.sha256}`);
      log(`steps: ${result.steps.join(' → ')}`);
    });
  } catch (error) {
    process.stderr.write(`[publish] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
