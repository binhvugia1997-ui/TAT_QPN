/**
 * The update manifest and the version/build model.
 *
 * Ordering is decided by the integer `build`, never by comparing version strings: `"0.10.0"`
 * sorts before `"0.7.0"` lexicographically, which would silently downgrade an owner's PC.
 * `version` is for humans.
 *
 * The manifest is untrusted input — it arrives from a LAN share — so every field is validated
 * and the package filename is checked against traversal, absolute, drive and UNC injection
 * before it is ever joined to a directory.
 */

export const MANIFEST_FILENAME = 'version.json';
export const TEST_CHANNEL = 'test';

export interface AppVersion {
  version: string;
  build: number;
}

export interface UpdateManifest extends AppVersion {
  product: string;
  channel: string;
  architecture: string;
  /** Bare file name only; never a path. */
  package: string;
  sha256: string;
  size: number;
  publishedAt: string;
  releaseNotes?: string;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

export const EXPECTED_PRODUCT = 'TNP Defect Management System';
export const EXPECTED_ARCHITECTURE = 'win-x64';

/** Semver-ish, deliberately permissive: this is a label, not an ordering key. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u;
/** One plain file name: no separators, no drive, no leading dots, no reserved names. */
const SAFE_PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.zip$/u;

export function readAppVersion(source: { version?: unknown; tnpBuild?: unknown }): AppVersion {
  const version = typeof source.version === 'string' ? source.version.trim() : '';
  const build = Number(source.tnpBuild);
  if (!VERSION_PATTERN.test(version)) {
    throw new ManifestError(`The application version "${String(source.version)}" is not a valid version.`);
  }
  if (!Number.isInteger(build) || build <= 0) {
    throw new ManifestError(`The application build "${String(source.tnpBuild)}" must be a positive integer.`);
  }
  return { version, build };
}

/** The single authoritative ordering rule for updates. */
export function isNewerBuild(remoteBuild: unknown, localBuild: number): boolean {
  return typeof remoteBuild === 'number' && Number.isInteger(remoteBuild) && remoteBuild > localBuild;
}

/**
 * A package name that cannot escape the update directory. Rejects traversal, separators,
 * absolute paths, drive letters and UNC prefixes.
 */
export function assertSafePackageFileName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ManifestError('The manifest package name is required.');
  }
  const name = value.trim();
  if (name !== value) throw new ManifestError('The manifest package name must not have surrounding spaces.');
  if (name.includes('/') || name.includes('\\')) {
    throw new ManifestError('The manifest package name must not contain a path separator.');
  }
  if (name.startsWith('..') || name.split('.').includes('..')) {
    throw new ManifestError('The manifest package name must not traverse directories.');
  }
  if (/^[A-Za-z]:/u.test(name)) throw new ManifestError('The manifest package name must not be a drive path.');
  if (name.startsWith('\\\\')) throw new ManifestError('The manifest package name must not be a UNC path.');
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    throw new ManifestError('The manifest package name contains a control character.');
  }
  if (!SAFE_PACKAGE_PATTERN.test(name)) {
    throw new ManifestError(`The manifest package name "${name}" is not a simple .zip file name.`);
  }
  return name;
}

export function isSafePackageFileName(value: unknown): boolean {
  try {
    assertSafePackageFileName(value);
    return true;
  } catch {
    return false;
  }
}

/** Strict parse: anything unexpected is rejected rather than coerced. */
export function parseManifest(raw: string): UpdateManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManifestError('The update manifest is not valid JSON.');
  }
  return toManifest(parsed);
}

export function toManifest(parsed: unknown): UpdateManifest {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ManifestError('The update manifest must be a JSON object.');
  }
  const source = parsed as Record<string, unknown>;

  const product = requireString(source, 'product');
  if (product !== EXPECTED_PRODUCT) {
    throw new ManifestError(`The manifest product "${product}" is not "${EXPECTED_PRODUCT}".`);
  }

  const channel = requireString(source, 'channel');
  if (channel.trim().length === 0 || channel.length > 32 || !/^[a-z0-9-]+$/u.test(channel)) {
    throw new ManifestError('The manifest channel must be a short lowercase identifier.');
  }

  const architecture = requireString(source, 'architecture');
  if (architecture !== EXPECTED_ARCHITECTURE) {
    throw new ManifestError(`The manifest architecture "${architecture}" is not "${EXPECTED_ARCHITECTURE}".`);
  }

  const version = requireString(source, 'version');
  if (!VERSION_PATTERN.test(version)) {
    throw new ManifestError(`The manifest version "${version}" is not a valid version.`);
  }

  const build = source.build;
  if (typeof build !== 'number' || !Number.isInteger(build) || build <= 0) {
    throw new ManifestError('The manifest build must be a positive integer.');
  }

  const sha256 = requireString(source, 'sha256').toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new ManifestError('The manifest sha256 must be 64 hexadecimal characters.');
  }

  const size = source.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    throw new ManifestError('The manifest size must be a positive integer number of bytes.');
  }

  const publishedAt = requireString(source, 'publishedAt');
  if (!ISO8601_PATTERN.test(publishedAt) || Number.isNaN(Date.parse(publishedAt))) {
    throw new ManifestError('The manifest publishedAt must be an ISO-8601 timestamp.');
  }

  const manifest: UpdateManifest = {
    product,
    channel,
    version,
    build,
    architecture,
    package: assertSafePackageFileName(source.package),
    sha256,
    size,
    publishedAt,
  };

  if (source.releaseNotes !== undefined) {
    if (typeof source.releaseNotes !== 'string') {
      throw new ManifestError('The manifest releaseNotes must be a string when present.');
    }
    if (source.releaseNotes.length > 4_000) {
      throw new ManifestError('The manifest releaseNotes are too long.');
    }
    manifest.releaseNotes = source.releaseNotes;
  }

  return manifest;
}

export function serializeManifest(manifest: UpdateManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function describeVersion(value: AppVersion): string {
  return `Version ${value.version} / Build ${value.build}`;
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw new ManifestError(`The manifest field "${key}" must be a string.`);
  return value;
}
