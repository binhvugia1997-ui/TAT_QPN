/**
 * Streaming SHA-256 over a file, reporting real progress.
 *
 * SHA-256 proves the bytes that arrived are the bytes that were published. It does **not**
 * prove who published them: anyone who can write to the LAN update share can publish a
 * matching package and manifest. See docs/phase7-lan-auto-update.md.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { computePercent } from './transfer';

export interface HashProgress {
  bytesHashed: number;
  totalBytes: number;
  percent: number;
}

export function sha256File(file: string, onProgress?: (progress: HashProgress) => void): string {
  const total = fs.statSync(file).size;
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  let offset = 0;
  try {
    for (;;) {
      const read = fs.readSync(handle, chunk, 0, chunk.length, offset);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      offset += read;
      onProgress?.({ bytesHashed: offset, totalBytes: total, percent: computePercent(offset, total) });
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

export function sha256Buffer(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Constant-length, case-insensitive comparison of two hex digests. */
export function digestsMatch(expected: string, actual: string): boolean {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const a = expected.trim().toLowerCase();
  const b = actual.trim().toLowerCase();
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
