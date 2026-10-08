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
  /**
   * Move the build number up to `published + 1` when the target is already at or ahead of the
   * requested build, instead of failing. Off in the library so a programmatic publish cannot
   * quietly invent a number nobody built; the CLI turns it on unless `--no-bump-build` is given.
   */
  bumpBuild?: boolean;
  /**
   * Refuse outright when the target already carries a manifest.
   *
   * This is the guard that keeps a TEST publish from landing on a production share: a TEST
   * channel may replace its own previous manifest, but pointing the tool at a folder that
   * already publishes something else is stopped before anything is written.
   */
  requireEmptyTarget?: boolean;
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
  /** The build that was requested, before the safety gate moved it forward. */
  requestedBuild: number;
  /** True when the gate bumped the build because the share was already at or ahead of it. */
  buildBumped: boolean;
}

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

/**
 * Reasons a LAN target cannot be published to, kept as a small closed set so a batch script can
 * map each one to a distinct operator instruction instead of a stack trace.
 */
export type TargetUnusableReason =
  | 'not-a-directory'
  | 'not-readable'
  | 'not-writable'
  | 'unreachable'
  | 'unsafe-path';

export interface TargetCheck {
  ok: boolean;
  /** True when the folder existed before the check — a created folder is a different warning. */
  existed: boolean;
  created: boolean;
  reason: TargetUnusableReason | null;
  /** The share this target resolves to, for the log. */
  target: string;
  /** Number of `\server\share` levels, when the path is a UNC path. */
  shareDepth: number | null;
  message: string;
}

/**
 * Validates network access and write permission on a LAN update folder before a build is spent.
 *
 * Publishing to a share costs a full build, so the check is deliberately cheap and it is
 * deliberately *probing* rather than asking: `fs.access` reports success on a read-only SMB
 * mount for W_OK on some Windows providers, so a real temporary file is created, read back and
 * removed. Anything left behind is a bug worth failing on.
 *
 * It never throws. A share that is offline, a folder that does not exist yet, and a folder that
 * cannot be written are three different operator problems and get three different answers.
 */
export function checkPublishTarget(targetDir: string, options: { create?: boolean } = {}): TargetCheck {
  const create = options.create !== false;
  const base: TargetCheck = {
    ok: false,
    existed: false,
    created: false,
    reason: null,
    target: targetDir,
    shareDepth: shareDepthOf(targetDir),
    message: '',
  };

  if (!targetDir || !targetDir.trim()) {
    return { ...base, reason: 'unsafe-path', message: 'The update folder is empty.' };
  }
  // A drive-relative or namespace-escaped path is never a publish destination.
  if (NAMESPACE_PATH_PATTERN.test(targetDir)) {
    return { ...base, reason: 'unsafe-path', message: 'This kind of Windows namespace path cannot be a publish target.' };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(targetDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      if (!create) {
        return { ...base, reason: 'unreachable', message: `The update folder "${targetDir}" does not exist.` };
      }
      return createAndProbe(base);
    }
    if (code === 'EPERM' || code === 'EACCES') {
      return { ...base, reason: 'not-readable', message: `The update folder could not be read: ${code}.` };
    }
    // An offline share surfaces as ENETUNREACH / ETIMEDOUT / EHOSTDOWN / EBUSY and, on Windows
    // through a mapping provider, sometimes as ENODEV or EINVAL.
    return {
      ...base,
      reason: 'unreachable',
      message: `The update folder could not be reached (${code ?? 'unknown error'}). Is the share online and the VPN up?`,
    };
  }

  if (!stats.isDirectory()) {
    return { ...base, existed: true, reason: 'not-a-directory', message: `"${targetDir}" exists but is not a folder.` };
  }

  return probeWrite({ ...base, existed: true });
}

function createAndProbe(base: TargetCheck): TargetCheck {
  try {
    fs.mkdirSync(base.target, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') {
      return { ...base, reason: 'not-writable', message: `The update folder could not be created: the share refuses writes (${code}).` };
    }
    return { ...base, reason: 'unreachable', message: `The update folder could not be created (${code ?? 'unknown error'}).` };
  }
  return probeWrite({ ...base, existed: true, created: true });
}

/** Creates, reads back and removes a real file: the only write proof that means anything. */
function probeWrite(base: TargetCheck): TargetCheck {
  const probePath = path.join(base.target, `.tnp-publish-probe-${process.pid}-${Date.now()}.tmp`);
  const probeBytes = 'tnp publish target probe';
  try {
    fs.writeFileSync(probePath, probeBytes, 'utf8');
    const readBack = fs.readFileSync(probePath, 'utf8');
    if (readBack !== probeBytes) {
      return { ...base, reason: 'not-writable', message: 'The update folder accepted a write but read back different bytes.' };
    }
    // An SMB share that re-opens for read immediately proves the bytes really landed.
    return {
      ...base,
      ok: true,
      reason: null,
      message: base.created
        ? `The update folder was created and accepts writes: ${base.target}`
        : `The update folder is reachable and accepts writes: ${base.target}`,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') {
      return {
        ...base,
        reason: 'not-writable',
        message: `The update folder is read-only for this account (${code}): ${base.target}`,
      };
    }
    return { ...base, reason: 'unreachable', message: `The update folder could not be written (${code ?? 'unknown error'}).` };
  } finally {
    try {
      fs.rmSync(probePath, { force: true });
    } catch {
      // A probe we cannot remove is worth knowing about, but never a reason to stop a publish.
    }
  }
}

/**
 * How deep below the server a target sits: `\server\share` → 2, `\server\share\a` → 3.
 *
 * `null` means "not a UNC path" (a local folder, which is legitimate for tests and development).
 * Namespace-escaped paths report `null` as well, so nothing downstream can mistake one for a
 * network location. Both separators are accepted because an Explorer address bar yields `/`.
 */
export function shareDepthOf(targetDir: string): number | null {
  if (NAMESPACE_PATH_PATTERN.test(targetDir)) return null;
  if (!targetDir.startsWith('\\\\') && !targetDir.startsWith('//')) return null;
  const segments = targetDir
    .slice(2)
    .split(PATH_SEPARATORS)
    .filter((segment) => segment.length > 0);
  return segments.length;
}

/**
 * How many path levels a manifest's `package` name will be resolved against. The publisher
 * writes `<targetDir>\<package>`, so a target that IS the share root and a target nested inside
 * it behave identically — this is reported so an operator can see which folder they chose.
 */
export function describeTarget(target: TargetCheck | null, manifest: UpdateManifest | null): string {
  const head = target ? `${target.target} (${target.shareDepth === null ? 'local folder' : `UNC depth ${target.shareDepth}`})` : 'unknown target';
  return manifest ? `${head} → build ${manifest.build}, ${manifest.package}` : head;
}

/**
 * The build actually safe to publish.
 *
 * `package.json` is authoritative, so it is normally used as-is. When the target already
 * publishes an equal or newer build, the number is moved to `published + 1` rather than failing:
 * a shared LAN folder is written by more than one developer, and refusing to publish until someone
 * remembers to edit `package.json` produces exactly the outcome the gate exists to prevent —
 * an operator pointing the client at a half-published build.
 */
export function nextPublishableBuild(requested: number, publishedBuild: number | null): { build: number; bumped: boolean } {
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new PublishError('The build number must be a positive integer.');
  }
  if (publishedBuild === null) return { build: requested, bumped: false };
  if (!Number.isInteger(publishedBuild) || publishedBuild <= 0) return { build: requested, bumped: false };
  if (requested > publishedBuild) return { build: requested, bumped: false };
  return { build: publishedBuild + 1, bumped: true };
}

const TEMP_SUFFIX = '.tmp';
const STALE_TEMP_MS = 6 * 60 * 60 * 1000;

/**
 * A `\server\share` path is the only network location a publish may target. `\?\` and `\.`\ are
 * Win32 namespace escapes (device paths, the DOS-device form) and must never be written into,
 * so they are rejected before anything touches the filesystem.
 *
 * Written with explicit escapes rather than an inline `/.../` literal: `[\\/]` inside a regex
 * character class is easy to author as `[?.]`, which is "an optional dot" and matches nothing
 * useful — a mistake that only shows up as a share that happily accepts a device path.
 */
const NAMESPACE_PATH_PATTERN = new RegExp('^[\\\\/]{2}[?\\\\.][\\\\/]', 'u');
/** Separators inside a Windows path: both are accepted on input, only `\` is produced. */
const PATH_SEPARATORS = new RegExp('[\\\\/]', 'u');

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

  const requestedBuild = input.build;

  // Reachability and write permission are settled before any work is done, so a build is never
  // spent against a share that cannot accept it. `mkdirSync` alone would silently create a
  // plausible-looking local folder when a typo'd UNC fails to resolve.
  const target = checkPublishTarget(input.targetDir, { create: true });
  if (!target.ok) {
    throw new PublishError(`The update folder is not usable: ${target.message}`);
  }
  if (target.created) log(`created the update folder ${target.target}`);
  steps.push('check-target');

  fs.mkdirSync(input.targetDir, { recursive: true });
  cleanStaleTempFiles(input.targetDir, now().getTime(), log);

  // Gate: never replace a manifest that belongs to another channel or that the caller did not
  // mean to touch. A production share must not be overwritten by a TEST publish.
  const existing = readExistingManifest(input.targetDir);
  if (existing && existing.channel !== input.channel) {
    throw new PublishError(
      `The update folder already publishes channel "${existing.channel}", not "${input.channel}". Refusing to replace it.`,
    );
  }
  if (input.requireEmptyTarget === true && existing) {
    throw new PublishError(
      `The update folder already publishes build ${existing.build} on channel "${existing.channel}" and --require-empty-target was given. Nothing was written.`,
    );
  }

  // Build safety: `package.json` wins; a share already at or ahead of it only moves the number
  // up when the caller asked for that explicitly.
  const buildDecision = nextPublishableBuild(requestedBuild, existing ? existing.build : null);
  if (buildDecision.bumped && input.bumpBuild !== true) {
    throw new PublishError(
      `The update source already publishes build ${existing?.build}; refusing to publish build ${requestedBuild}. `
      + 'Raise tnpBuild in package.json, or let the publisher use the next free build.',
    );
  }
  const build = buildDecision.build;
  if (buildDecision.bumped) {
    log(`build ${requestedBuild} is already published; bumping to ${build}`);
    steps.push('bump-build');
  }

  const requestedName = input.packageName ?? defaultPackageName(input.version, build, input.channel);
  const packageName = assertPublishablePackageName(requestedName, input.targetDir);

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
      build,
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

    return {
      ok: true,
      manifest,
      packagePath: finalPath,
      sha256,
      size,
      message: buildDecision.bumped ? `Published as build ${build} (requested ${requestedBuild}).` : 'Published.',
      steps,
      requestedBuild,
      buildBumped: buildDecision.bumped,
    };
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

/** Boolean switches carry no value, so they must be parsed positionally, not greedily. */
const PUBLISH_BOOLEAN_FLAGS = ['fail-if-exists', 'bump-build', 'no-bump-build', 'check-only'] as const;

export interface PublishCliOptions {
  sourceDir: string;
  targetDir: string;
  channel: string;
  releaseNotes?: string;
  packageName?: string;
  /** Refuse to touch a target that already publishes a manifest. */
  requireEmptyTarget?: boolean;
  /** Move the build number up instead of failing when the target is at or ahead of it. */
  bumpBuild?: boolean;
  /** Validate the target and report the build that would be published, without publishing. */
  checkOnly?: boolean;
  /**
   * The project root whose `package.json` holds the authoritative version and build.
   *
   * This exists because the compiled script's own location is not a reliable answer: run from the
   * checkout it sits three levels below `package.json`, but inside a portable runtime it sits in
   * `resources/app/dist/...` where the same relative path lands on the *runtime's* metadata file,
   * not the project's. Passing the root makes the bump write the file that will be built next.
   */
  projectDir?: string;
}

/** Where the authoritative `package.json` lives for this run. */
export function resolveAppPackageJson(projectDir?: string): string {
  if (projectDir && projectDir.trim()) return path.join(path.resolve(projectDir.trim()), 'package.json');
  return path.resolve(__dirname, '../../../package.json');
}

export function parsePublishArgs(argv: readonly string[]): PublishCliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const stray: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      // Any token that is not an option *name* and was not consumed as the value of one. Because
      // each value is taken by `index += 1` below, anything reaching here is unattached.
      stray.push(token);
      continue;
    }
    const name = token.slice(2);
    if ((PUBLISH_BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      // A switch: the next token is the *next* argument, not this one's value.
      flags.add(name);
      continue;
    }
    values.set(name, String(argv[index + 1] ?? ''));
    index += 1;
  }
  // Checked before the required-argument rule, because this is what an unquoted spaced path looks
  // like from here: `--target \\SERVER\\Share\\TAT QPN\\updates` arrives as a truncated `target` plus a
  // stray `QPN\\updates`. The truncated folder is a real, creatable path, and the publisher creates
  // missing target folders, so accepting it would write a manifest no client is configured to read —
  // and every client would then report an update whose package is not there. The batch script refuses
  // a second argument for the same reason; this covers the manual command line.
  if (stray.length > 0) {
    throw new PublishError(
      `Unexpected argument${stray.length === 1 ? '' : 's'}: ${stray.join(' ')}. `
      + 'Quote a folder path that contains a space, otherwise it is read as two arguments and the '
      + 'path stops at the space.',
    );
  }

  const sourceDir = values.get('source') ?? '';
  const targetDir = values.get('target') ?? '';
  // `--check-only` validates a folder and needs no source, so it is exempt from that rule.
  if (!targetDir || (!sourceDir && !flags.has('check-only'))) {
    throw new PublishError(
      'Usage: publish.js --source <portable folder> --target <LAN folder> [--channel test] [--notes "..."] '
      + '[--package name.zip] [--project <repo root>] [--bump-build] [--fail-if-exists] '
      + '| publish.js --target <LAN folder> --check-only',
    );
  }
  return {
    sourceDir,
    targetDir,
    // TEST is the only channel this tool publishes by default; a production manifest is a
    // separate folder and a separate, deliberate action.
    channel: (values.get('channel') ?? TEST_CHANNEL).trim().toLowerCase(),
    releaseNotes: values.get('notes'),
    packageName: values.get('package'),
    requireEmptyTarget: flags.has('fail-if-exists'),
    projectDir: (values.get('project') ?? '').trim() || undefined,
    // One-click publishing must not dead-end on "someone else's build number is already taken",
    // so bumping is on by default; `--no-bump-build` restores the strict rule that package.json
    // is the only authority and the operator must raise it deliberately.
    bumpBuild: !flags.has('no-bump-build'),
    checkOnly: flags.has('check-only'),
  };
}

/**
 * Writes `version` / `tnpBuild` back to the application's package.json.
 *
 * Only the two keys are touched and the file is rewritten through a temporary name and a rename,
 * because the portable build reads this file: a half-written package.json produces an app that
 * reports no version at all. This is what lets a bumped build number reach the client, so the
 * installed version the Owner PC reports matches the manifest that was published for it.
 */
export function writeAppVersionFile(
  packageJsonPath: string,
  next: { version: string; build: number },
): void {
  if (!Number.isInteger(next.build) || next.build <= 0) {
    throw new PublishError('The build number must be a positive integer.');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new PublishError(`The application package.json could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  parsed.version = next.version;
  parsed.tnpBuild = next.build;

  const temporary = `${packageJsonPath}.tnp-bump.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, packageJsonPath);
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

    // `--check-only` is the pre-flight the batch script runs before it spends a build on a share
    // it cannot write to: reachability, write permission, the current published build, and the
    // build number that *would* be used.
    if (options.checkOnly) {
      const target = checkPublishTarget(options.targetDir, { create: false });
      const existing = readExistingManifest(options.targetDir);
      const packageJsonPath = resolveAppPackageJson(options.projectDir);
      const current = fs.existsSync(packageJsonPath) ? readAppVersionFile(packageJsonPath) : null;

      log(`target     : ${target.target}`);
      log(`kind       : ${target.shareDepth === null ? 'local folder' : `UNC, ${target.shareDepth} segment${target.shareDepth === 1 ? '' : 's'} deep`}`);
      log(`reachable  : ${target.ok || target.existed ? 'yes' : 'no'}`);
      log(`writable   : ${target.ok ? 'yes' : 'no'}`);
      log(`published  : ${existing ? `build ${existing.build} (channel ${existing.channel})` : 'nothing yet'}`);
      if (current) {
        const decision = nextPublishableBuild(current.build, existing ? existing.build : null);
        log(`app version: ${current.version} / build ${current.build}`);
        log(`next build : ${decision.build}${decision.bumped ? ' (bumped over the published build)' : ''}`);
        if (decision.bumped && !options.bumpBuild) {
          log('the published build is not behind package.json; pass --bump-build or raise tnpBuild.');
        }
      }
      if (options.channel && existing && existing.channel !== options.channel) {
        log(`BLOCKED: the folder publishes channel "${existing.channel}", not "${options.channel}".`);
        process.exitCode = 1;
      } else if (!target.ok) {
        log(`BLOCKED: ${target.message}`);
        process.exitCode = 1;
      } else {
        log('the update folder is usable.');
      }
      process.exitCode = process.exitCode ?? (target.ok && (!existing || existing.channel === options.channel) ? 0 : 1);
      if (target.created) log(`created    : ${target.target}`);
      process.exit(process.exitCode ?? 0);
    }

    // With a project root the bump is written back to the file the *next build* compiles, so the
    // number the client reports and the number in the manifest cannot drift apart.
    const packageJsonPath = resolveAppPackageJson(options.projectDir);
    const { version, build } = readAppVersionFile(packageJsonPath);
    void publishUpdate({ ...options, version, build, log }).then((result) => {
      if (!result.ok) {
        process.stderr.write(`[publish] FAILED: ${result.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (result.buildBumped) {
        // Keep the source of truth honest: the bumped number is what the client will read back as
        // its installed version, so it has to be in package.json for the *next* build too.
        try {
          writeAppVersionFile(packageJsonPath, {
            version: result.manifest?.version ?? version,
            build: result.manifest?.build ?? build,
          });
          log(`package.json updated to build ${result.manifest?.build} so the next build matches what was published`);
        } catch (error) {
          log(`warning: package.json was not updated (${error instanceof Error ? error.message : String(error)})`);
        }
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
