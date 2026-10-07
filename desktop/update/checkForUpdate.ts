/**
 * The startup update check.
 *
 * Non-blocking and optional by design: TNP must open and work normally even when the LAN
 * update share is unreachable, switched off, or slow. An unreachable source is a *soft*
 * failure — it is written to the updater log and otherwise ignored, never surfaced as an
 * error dialog and never retried in a loop.
 */
import { ManifestError, isNewerBuild, parseManifest } from './manifest';
import type { AppVersion, UpdateManifest } from './manifest';

export type UpdateCheckStatus = 'up-to-date' | 'update-available' | 'same-build' | 'older-remote' | 'unavailable';

export type UpdateCheckResult =
  | { status: 'up-to-date' | 'same-build' | 'older-remote'; local: AppVersion; remote: UpdateManifest | null }
  | { status: 'update-available'; local: AppVersion; remote: UpdateManifest; manifestSource: string }
  | { status: 'unavailable'; local: AppVersion; reason: string };

/** Timeout for the manifest read only; the package copy has its own progress reporting. */
export const MANIFEST_TIMEOUT_MS = 8_000;

export interface UpdateSource {
  /** Human-readable origin, recorded in diagnostics (for example a UNC path). */
  readonly description: string;
  /** Returns the raw `version.json` text, or throws when the source is unreachable. */
  readManifest(): Promise<string>;
}

export interface CheckOptions {
  local: AppVersion;
  /** Channel this client accepts; a manifest for another channel is ignored. */
  channel: string;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Reads and validates the remote manifest, then decides what to do. Never throws: a failure
 * becomes `{ status: 'unavailable' }` so the caller can log it and carry on.
 */
export async function checkForUpdate(source: UpdateSource, options: CheckOptions): Promise<UpdateCheckResult> {
  const { local, channel } = options;

  let raw: string;
  try {
    raw = await withTimeout(source.readManifest(), options.timeoutMs ?? MANIFEST_TIMEOUT_MS);
  } catch (error) {
    return { status: 'unavailable', local, reason: describeFailure(error) };
  }

  let manifest: UpdateManifest;
  try {
    manifest = parseManifest(raw);
  } catch (error) {
    // A malformed manifest is a hard content problem, but still must not break the app.
    return {
      status: 'unavailable',
      local,
      reason: error instanceof ManifestError ? error.message : 'The update manifest could not be read.',
    };
  }

  if (manifest.channel !== channel) {
    return {
      status: 'unavailable',
      local,
      reason: `The manifest channel "${manifest.channel}" does not match this client's "${channel}".`,
    };
  }

  if (isNewerBuild(manifest.build, local.build)) {
    return { status: 'update-available', local, remote: manifest, manifestSource: source.description };
  }
  if (manifest.build === local.build) {
    return { status: 'same-build', local, remote: manifest };
  }
  return { status: 'older-remote', local, remote: manifest };
}

/**
 * Suppresses repeat prompts for a build the owner already declined *during this session*.
 * Deliberately in-memory: restarting TNP should be allowed to remind them again.
 */
export function createDismissalList(): {
  dismiss(build: number): void;
  isDismissed(build: number): boolean;
  clear(): void;
} {
  const dismissed = new Set<number>();
  return {
    dismiss: (build) => { dismissed.add(build); },
    isDismissed: (build) => dismissed.has(build),
    clear: () => { dismissed.clear(); },
  };
}

/** Serialises the updater's own state so it can be sent to the renderer and logged. */
export function summariseCheck(result: UpdateCheckResult): Record<string, unknown> {
  switch (result.status) {
    case 'update-available':
      return {
        status: result.status,
        local: result.local,
        remote: { version: result.remote.version, build: result.remote.build },
        manifestSource: result.manifestSource,
        package: result.remote.package,
        size: result.remote.size,
        publishedAt: result.remote.publishedAt,
        releaseNotes: result.remote.releaseNotes ?? null,
      };
    case 'unavailable':
      return { status: result.status, local: result.local, reason: result.reason };
    default:
      return {
        status: result.status,
        local: result.local,
        remote: result.remote ? { version: result.remote.version, build: result.remote.build } : null,
      };
  }
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/iu.test(message)) return 'The LAN update source did not respond in time.';
  if (/ENOENT|no such file/iu.test(message)) return 'The LAN update source could not be found.';
  if (/EACCES|EPERM|permission/iu.test(message)) return 'The LAN update source refused access.';
  return `The LAN update source could not be read: ${message}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`The update check timed out after ${ms} ms.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
