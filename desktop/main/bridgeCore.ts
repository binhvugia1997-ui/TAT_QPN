/**
 * Validation and state for the owner's native file bridge.
 *
 * Threat model: the renderer is a web page. It must never be able to make the desktop open,
 * read or write an arbitrary path. Three rules enforce that:
 *
 * 1. **The renderer never supplies a path.** To attach a report the desktop opens a native
 *    file picker and hands the renderer an opaque, single-use, expiring *token*. The path
 *    stays in the main process.
 * 2. **The desktop never invents a path to open.** To open a report it asks the loopback
 *    server, which resolves the record's managed report through the Phase 5 containment and
 *    symlink checks, and then re-verifies containment itself before opening.
 * 3. **No shell.** Only `shell.openPath` on a verified managed report. No `exec`, no
 *    arbitrary `shell.openExternal`, no command construction from record data.
 *
 * This module is Electron-free so the rules are unit tested directly.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_TOKENS = 64;
/** Attach cap: report PDFs and images, not multi-gigabyte dumps. */
export const MAX_ATTACH_BYTES = 100 * 1024 * 1024;

export interface PickedFile {
  filePath: string;
  fileName: string;
  sizeBytes: number;
}

export interface TokenEntry extends PickedFile {
  issuedAt: number;
  expiresAt: number;
  used: boolean;
}

export interface FileTokenStore {
  issue(file: PickedFile, now?: number): string;
  /** Returns the entry and marks it used, or null when unknown/expired/already used. */
  consume(token: string, now?: number): TokenEntry | null;
  size(): number;
}

export function createFileTokenStore(options: { ttlMs?: number; maxTokens?: number } = {}): FileTokenStore {
  const ttlMs = options.ttlMs ?? TOKEN_TTL_MS;
  const maxTokens = options.maxTokens ?? MAX_TOKENS;
  const entries = new Map<string, TokenEntry>();

  return {
    issue(file, now = Date.now()) {
      prune(entries, now);
      while (entries.size >= maxTokens) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      const token = crypto.randomUUID();
      entries.set(token, { ...file, issuedAt: now, expiresAt: now + ttlMs, used: false });
      return token;
    },
    consume(token, now = Date.now()) {
      if (!isOpaqueToken(token)) return null;
      const entry = entries.get(token);
      // Single use, always: delete before deciding so a failure cannot be replayed.
      entries.delete(token);
      if (!entry || entry.used) return null;
      if (now > entry.expiresAt) return null;
      entry.used = true;
      return entry;
    },
    size: () => entries.size,
  };
}

/** Tokens are UUIDs; anything else is rejected before a map lookup. */
export function isOpaqueToken(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

/**
 * Canonical record id, matching the server's rule: integers as numbers, everything else a
 * non-empty trimmed string. Prevents `1`, `'1'` and `' 1 '` being three different records.
 */
export function normalizeBridgeRecordId(value: unknown): string | number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) throw new BridgeValidationError('A record id is required.');
    if (/^-?\d+$/u.test(trimmed) && trimmed.length <= 15) return Number(trimmed);
    if (trimmed.length <= 200) return trimmed;
  }
  throw new BridgeValidationError('The record id is not valid.');
}

export class BridgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeValidationError';
  }
}

export interface ContainmentCheck {
  allowed: boolean;
  reason?: string;
  resolvedPath?: string;
}

/**
 * Confirms a path the server returned really is a regular file inside the managed reports
 * folder. Symlinks are resolved first so a link pointing outside cannot be opened.
 */
export function checkManagedReportPath(candidate: unknown, reportsDir: string): ContainmentCheck {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return { allowed: false, reason: 'The server did not return a report path.' };
  }
  if (!path.isAbsolute(candidate)) {
    return { allowed: false, reason: 'Refusing a relative report path.' };
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync.native(candidate);
  } catch {
    return { allowed: false, reason: 'The managed report file could not be resolved.' };
  }

  let root: string;
  try {
    root = fs.realpathSync.native(reportsDir);
  } catch {
    return { allowed: false, reason: 'The managed report folder could not be resolved.' };
  }

  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { allowed: false, reason: 'The report is outside the managed report folder.' };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    return { allowed: false, reason: 'The managed report file is unavailable.' };
  }
  if (!stats.isFile()) return { allowed: false, reason: 'The managed report is not a file.' };

  return { allowed: true, resolvedPath: resolved };
}

/** Rejects oversized or absurd picker results before any bytes are read. */
export function describePickedFile(filePath: string): PickedFile {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new BridgeValidationError('The selection is not a file.');
  if (stats.size > MAX_ATTACH_BYTES) {
    throw new BridgeValidationError(`The selected file is larger than ${Math.floor(MAX_ATTACH_BYTES / (1024 * 1024))} MB.`);
  }
  return { filePath, fileName: path.basename(filePath), sizeBytes: stats.size };
}

function prune(entries: Map<string, TokenEntry>, now: number): void {
  for (const [token, entry] of entries) {
    if (entry.used || now > entry.expiresAt) entries.delete(token);
  }
}
