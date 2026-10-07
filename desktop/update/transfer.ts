/**
 * Real byte-level transfer progress.
 *
 * Progress is derived from bytes actually written to the destination, never from a timer, so
 * a stalled LAN share shows a stalled bar rather than a confident lie.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const UPDATE_STAGES = [
  'CHECKING',
  'COPYING',
  'VERIFYING',
  'VALIDATING',
  'STAGING',
  'WAITING_FOR_EXIT',
  'INSTALLING',
  'ROLLING_BACK',
  'RESTARTING',
  'COMPLETE',
  'FAILED',
] as const;

export type UpdateStage = (typeof UPDATE_STAGES)[number];

export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  /** 0..100, integer, derived from real bytes. */
  percent: number;
  /** Bytes per second over the transfer so far. */
  transferRate: number;
  stage: UpdateStage;
}

export interface CopyOptions {
  chunkSize?: number;
  onProgress?: (progress: TransferProgress) => void;
  stage?: UpdateStage;
  now?: () => number;
  /** Aborts the copy; the partial destination file is removed. */
  signal?: { aborted: boolean };
}

const DEFAULT_CHUNK_SIZE = 1024 * 1024;

export class TransferError extends Error {
  constructor(message: string, public readonly bytesTransferred = 0) {
    super(message);
    this.name = 'TransferError';
  }
}

/**
 * Copies `source` to `destination` in chunks. The destination is written to a temporary name
 * and renamed only on success, so an interrupted copy never leaves a file that looks complete.
 */
export async function copyFileWithProgress(source: string, destination: string, options: CopyOptions = {}): Promise<number> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const stage = options.stage ?? 'COPYING';
  const now = options.now ?? Date.now;

  let stats: fs.Stats;
  try {
    stats = fs.statSync(source);
  } catch {
    throw new TransferError(`The update package could not be read from "${source}".`);
  }
  if (!stats.isFile()) throw new TransferError('The update package is not a file.');

  const totalBytes = stats.size;
  if (totalBytes === 0) throw new TransferError('The update package is empty.');

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  if (fs.existsSync(partial)) fs.rmSync(partial, { force: true });

  const startedAt = now();
  let transferred = 0;

  const readHandle = fs.openSync(source, 'r');
  const writeHandle = fs.openSync(partial, 'w');
  try {
    const buffer = Buffer.alloc(chunkSize);
    // A copy is inherently blocking in Node's fs sync API; yielding between chunks keeps the
    // progress callbacks and the abort check responsive.
    for (;;) {
      if (options.signal?.aborted) throw new TransferError('The update copy was cancelled.', transferred);
      const read = fs.readSync(readHandle, buffer, 0, chunkSize, transferred);
      if (read === 0) break;
      fs.writeSync(writeHandle, buffer, 0, read);
      transferred += read;
      report(options.onProgress, transferred, totalBytes, stage, startedAt, now);
      await yieldToEventLoop();
    }
  } catch (error) {
    fs.closeSync(readHandle);
    fs.closeSync(writeHandle);
    fs.rmSync(partial, { force: true });
    if (error instanceof TransferError) throw error;
    throw new TransferError(
      `The update copy failed after ${transferred} of ${totalBytes} bytes: `
      + (error instanceof Error ? error.message : String(error)),
      transferred,
    );
  }
  fs.closeSync(readHandle);
  fs.closeSync(writeHandle);

  const written = fs.statSync(partial).size;
  if (written !== totalBytes) {
    fs.rmSync(partial, { force: true });
    throw new TransferError(`The copy is incomplete: expected ${totalBytes} bytes, wrote ${written}.`, written);
  }

  if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
  fs.renameSync(partial, destination);
  report(options.onProgress, totalBytes, totalBytes, stage, startedAt, now);
  return totalBytes;
}

export function computePercent(transferred: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, transferred / total));
  return Math.floor(ratio * 100);
}

function report(
  onProgress: ((progress: TransferProgress) => void) | undefined,
  transferred: number,
  total: number,
  stage: UpdateStage,
  startedAt: number,
  now: () => number,
): void {
  if (!onProgress) return;
  const elapsedSeconds = Math.max(0.001, (now() - startedAt) / 1000);
  onProgress({
    bytesTransferred: transferred,
    totalBytes: total,
    percent: computePercent(transferred, total),
    transferRate: Math.round(transferred / elapsedSeconds),
    stage,
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}
