import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class DatabaseLockError extends Error {
  constructor(message: string, readonly holder?: LockInfo) {
    super(message);
    this.name = 'DatabaseLockError';
  }
}

export interface LockInfo {
  pid: number;
  hostname: string;
  startedAt: string;
  databaseFile: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(lockFile: string): LockInfo | undefined {
  try {
    if (!fs.existsSync(lockFile)) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.pid !== 'number' || typeof candidate.hostname !== 'string') return undefined;
    return {
      pid: candidate.pid,
      hostname: candidate.hostname,
      startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : '',
      databaseFile: typeof candidate.databaseFile === 'string' ? candidate.databaseFile : '',
    };
  } catch {
    return undefined;
  }
}

/**
 * Only one local server may own a data directory at a time. SQLite itself tolerates
 * several processes, but two servers writing audits and backups against the same file is
 * an operator mistake, so ownership is made explicit and failure is loud.
 */
export function acquireDatabaseLock(lockFile: string, databaseFile: string): () => void {
  const info: LockInfo = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    databaseFile,
  };

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  try {
    const handle = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(handle, `${JSON.stringify(info, null, 2)}\n`);
    fs.closeSync(handle);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new DatabaseLockError(`Could not create the database lock "${lockFile}".`, undefined);
    }

    const holder = readLock(lockFile);
    const sameHost = holder?.hostname === os.hostname();
    const alive = holder !== undefined && sameHost && isProcessAlive(holder.pid);

    if (alive) {
      throw new DatabaseLockError(
        `Another TNP server (pid ${holder.pid}) already owns "${databaseFile}". Stop it before starting a second one.`,
        holder,
      );
    }

    // A leftover lock from a crashed run, or from another machine on a copied folder.
    fs.rmSync(lockFile, { force: true });
    const handle = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(handle, `${JSON.stringify({ ...info, replacedStaleLock: true }, null, 2)}\n`);
    fs.closeSync(handle);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = readLock(lockFile);
    if (current && current.pid === process.pid && current.hostname === os.hostname()) {
      fs.rmSync(lockFile, { force: true });
    }
  };
}
