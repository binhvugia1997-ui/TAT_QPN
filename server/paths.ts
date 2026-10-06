import fs from 'node:fs';
import path from 'node:path';

/**
 * Every runtime directory is overridable so tests can point the server at an isolated
 * temporary location and the future portable build can point it at persistent folders
 * that live next to the executable instead of inside disposable build output.
 */
export interface RuntimePaths {
  root: string;
  dataDir: string;
  backupsDir: string;
  reportsDir: string;
  databaseFile: string;
  lockFile: string;
  configFile: string;
  seedFile: string;
  staticDir: string;
}

export interface RuntimePathOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function findProjectRoot(start: string): string {
  let current = path.resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(start);
}

export function resolveRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const env = options.env ?? process.env;
  const root = options.root ?? env.TNP_ROOT ?? findProjectRoot(options.cwd ?? process.cwd());

  const dataDir = path.resolve(root, env.TNP_DATA_DIR ?? 'data');
  const backupsDir = path.resolve(root, env.TNP_BACKUPS_DIR ?? 'backups');
  const reportsDir = path.resolve(root, env.TNP_REPORTS_DIR ?? 'reports');

  return {
    root,
    dataDir,
    backupsDir,
    reportsDir,
    databaseFile: env.TNP_DB_FILE
      ? path.resolve(root, env.TNP_DB_FILE)
      : path.join(dataDir, 'tnp.db'),
    lockFile: env.TNP_LOCK_FILE
      ? path.resolve(root, env.TNP_LOCK_FILE)
      : path.join(dataDir, 'tnp.lock'),
    configFile: env.TNP_CONFIG_FILE
      ? path.resolve(root, env.TNP_CONFIG_FILE)
      : path.join(dataDir, 'server.json'),
    seedFile: env.TNP_SEED_FILE
      ? path.resolve(root, env.TNP_SEED_FILE)
      : path.join(root, 'src', 'data', 'legacy-base-data.json'),
    staticDir: env.TNP_STATIC_DIR ? path.resolve(root, env.TNP_STATIC_DIR) : path.join(root, 'dist'),
  };
}

/** Creates the persistent runtime directories. Idempotent. */
export function ensureRuntimeDirectories(paths: RuntimePaths): void {
  for (const directory of [paths.dataDir, paths.backupsDir, paths.reportsDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

/** Relative paths only; absolute host paths must never be exposed through the API. */
export function describePath(paths: RuntimePaths, target: string): string {
  const relative = path.relative(paths.root, target);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : path.basename(target);
}
