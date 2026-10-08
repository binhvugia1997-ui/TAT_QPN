/**
 * The LAN update source.
 *
 * A source is just a folder the Owner PC can read — normally a UNC share such as
 * `\\BUILD-PC\TNP_Update\Test`, but any path works, including a local folder for testing.
 * Nothing is hard-coded: the location comes from `data/desktop-settings.json`, with
 * `TNP_UPDATE_SOURCE` available for development.
 *
 * The update package is never stored in `data/`, `backups/` or `reports/`. Those are
 * production data; mixing an update payload into them would put it in the backup set and in
 * the owner's own file copies.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MANIFEST_FILENAME, assertSafePackageFileName, parseManifest } from './manifest';
import type { UpdateManifest } from './manifest';
import { copyFileWithProgress } from './transfer';
import type { TransferProgress } from './transfer';
import type { UpdateSource } from './checkForUpdate';

export interface FileSourceOptions {
  /** Folder containing version.json and the packages. */
  root: string;
  now?: () => number;
}

export function createFileUpdateSource(options: FileSourceOptions): UpdateSource & {
  root: string;
  manifestPath: string;
  packagePath(name: string): string;
  copyPackage(name: string, destination: string, onProgress?: (p: TransferProgress) => void): Promise<number>;
} {
  const root = options.root.trim();
  if (root.length === 0) throw new Error('The update source folder is empty.');

  return {
    root,
    description: root,
    manifestPath: path.join(root, MANIFEST_FILENAME),

    async readManifest() {
      return fs.promises.readFile(path.join(root, MANIFEST_FILENAME), 'utf8');
    },

    packagePath(name: string) {
      // The name comes from an untrusted manifest; this is what stops it pointing elsewhere.
      const safe = assertSafePackageFileName(name);
      const resolved = path.resolve(root, safe);
      const relative = path.relative(path.resolve(root), resolved);
      if (relative !== safe) {
        throw new Error(`The package name "${name}" does not resolve inside the update source.`);
      }
      return resolved;
    },

    async copyPackage(name, destination, onProgress) {
      const source = this.packagePath(name);
      if (!fs.existsSync(source)) {
        throw new Error(`The update package "${name}" is not present at the update source.`);
      }
      return copyFileWithProgress(source, destination, { onProgress, stage: 'COPYING', now: options.now });
    },
  };
}

/**
 * Resolves the configured source root. An empty result means update checking is off, which is
 * a normal state rather than an error.
 */
export function resolveUpdateSourceRoot(input: {
  settingsSource: string;
  settingsChannel: string;
  checksEnabled: boolean;
  env?: Record<string, string | undefined>;
}): { root: string; channel: string } | null {
  const env = input.env ?? {};
  const root = (env.TNP_UPDATE_SOURCE?.trim() || input.settingsSource.trim());
  const channel = env.TNP_UPDATE_CHANNEL?.trim() || input.settingsChannel;

  if (input.checksEnabled === false) return null;
  if (!root) return null;
  return { root, channel };
}

/**
 * Pre-flight validation of a configured update source, surfaced in Settings.
 *
 * The updater itself is deliberately silent about a broken share — an unreachable folder must
 * never block startup — which means an operator configuring the path has no way to learn whether
 * it is right. This is that missing answer: a one-shot, explicit check that reads the share,
 * reports exactly what is missing, and never throws.
 *
 * It is read-only by design. A *client* must never write to the update folder; write permission
 * is the publisher's concern (`checkPublishTarget`), and conflating the two would let the Owner
 * PC's Settings page damage the share.
 */

export type UpdateSourceState =
  /** Nothing configured, so no check will run. Normal, not an error. */
  | 'not-configured'
  /** The folder could not be reached at all (offline share, bad server name, VPN down). */
  | 'unreachable'
  /** The folder is there but this PC may not read it. */
  | 'not-readable'
  /** The folder is readable and the client may also write — reported, never used. */
  | 'read-only'
  /** The folder is reachable but holds no `version.json` yet. */
  | 'no-manifest'
  /** `version.json` exists but is not a manifest this client accepts. */
  | 'invalid-manifest'
  /** Everything is in order and the manifest is readable. */
  | 'ready';

export interface UpdateSourceValidation {
  state: UpdateSourceState;
  /** The path as configured, normalised for display. */
  source: string;
  /** Human-readable reason, safe to show verbatim in Settings. */
  message: string;
  /** True when the client can use this source to update. */
  usable: boolean;
  /** The manifest that was read, when one parsed successfully. */
  manifest: { version: string; build: number; channel: string; package: string } | null;
  /** Whether the manifest's channel matches the channel this client accepts. */
  channelMatches: boolean | null;
  checkedAt: string;
}

export interface ValidateOptions {
  /** The channel this client accepts; a manifest for another channel is not usable. */
  channel?: string;
  now?: () => Date;
}

function classifyReadError(error: unknown): 'unreachable' | 'not-readable' {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'not-readable';
  return 'unreachable';
}

/**
 * Validates an update source folder. `read-only` is a *good* result for a client: it can update
 * but cannot damage the share.
 */
export async function validateUpdateSource(
  source: string,
  options: ValidateOptions = {},
): Promise<UpdateSourceValidation> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const trimmed = typeof source === 'string' ? source.trim() : '';
  const base: UpdateSourceValidation = {
    state: 'not-configured',
    source: trimmed,
    message: '',
    usable: false,
    manifest: null,
    channelMatches: null,
    checkedAt,
  };

  if (!trimmed) {
    return {
      ...base,
      message: 'No update folder is configured, so this PC will not check for updates.',
    };
  }

  // Reachable at all?
  try {
    const stats = await fs.promises.stat(trimmed);
    if (!stats.isDirectory()) {
      return { ...base, state: 'no-manifest', message: 'The configured update path is not a folder.' };
    }
  } catch (error) {
    const state = classifyReadError(error);
    return {
      ...base,
      state,
      message: state === 'not-readable'
        ? 'This PC can see the update folder but may not read it.'
        : 'The update folder could not be reached. Check the server name, the share, and the network.',
    };
  }

  // Readable?
  try {
    await fs.promises.access(trimmed, fs.constants.R_OK);
  } catch {
    return { ...base, state: 'not-readable', message: 'The update folder is not readable by this PC.' };
  }

  const manifestPath = path.join(trimmed, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await fs.promises.readFile(manifestPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return {
        ...base,
        state: 'no-manifest',
        message: `The folder is reachable but has no ${MANIFEST_FILENAME}. Nothing has been published to it yet.`,
      };
    }
    return {
      ...base,
      state: 'not-readable',
      message: `${MANIFEST_FILENAME} exists but could not be read (${code ?? 'unknown error'}).`,
    };
  }

  let manifest: UpdateManifest;
  try {
    manifest = parseManifest(raw);
  } catch (error) {
    return {
      ...base,
      state: 'invalid-manifest',
      message: error instanceof Error
        ? `${MANIFEST_FILENAME} is not a manifest this build accepts: ${error.message}`
        : `${MANIFEST_FILENAME} could not be read.`,
    };
  }

  const summary = {
    version: manifest.version,
    build: manifest.build,
    channel: manifest.channel,
    package: manifest.package,
  };
  const channelMatches = options.channel ? manifest.channel === options.channel : null;
  if (channelMatches === false) {
    return {
      ...base,
      state: 'invalid-manifest',
      manifest: summary,
      channelMatches,
      message: `The folder publishes channel "${manifest.channel}", which this PC does not accept.`,
    };
  }

  // Is the package itself present? A manifest without its archive means a half-finished publish.
  let packagePresent = false;
  try {
    const stats = await fs.promises.stat(path.join(trimmed, manifest.package));
    packagePresent = stats.isFile() && stats.size === manifest.size;
  } catch {
    packagePresent = false;
  }
  if (!packagePresent) {
    return {
      ...base,
      state: 'invalid-manifest',
      manifest: summary,
      channelMatches,
      message: `The manifest is valid but its package "${manifest.package}" is missing or the wrong size. The publish was incomplete.`,
    };
  }

  return {
    ...base,
    state: 'ready',
    usable: true,
    manifest: summary,
    channelMatches,
    message: `Ready: build ${manifest.build} (version ${manifest.version}) on channel "${manifest.channel}".`,
  };
}
