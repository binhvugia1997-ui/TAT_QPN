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
import { MANIFEST_FILENAME, assertSafePackageFileName } from './manifest';
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
