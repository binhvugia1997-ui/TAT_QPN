import type { IncomingMessage } from 'node:http';
import { ValidationFailedError } from '../errors';
import { parseRecordIdKey } from '../../src/business/records/recordKey';
import type { RecordId } from '../../src/models/defect-record';

export const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_UPLOAD_BODY_BYTES = 64 * 1024 * 1024;

export class PayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`The request body exceeds the ${limit} byte limit.`);
    this.name = 'PayloadTooLargeError';
  }
}

export function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(new PayloadTooLargeError(limit));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export async function readJsonBody<T = Record<string, unknown>>(
  request: IncomingMessage,
  limit = MAX_JSON_BODY_BYTES,
): Promise<T> {
  const raw = await readBody(request, limit);
  if (raw.byteLength === 0) return {} as T;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ValidationFailedError('The request body must be a JSON object.');
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof ValidationFailedError) throw error;
    throw new ValidationFailedError('The request body is not valid JSON.');
  }
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationFailedError(`"${field}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function requireRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new ValidationFailedError('"rows" must be an array.');
  if (value.length > 20_000) throw new ValidationFailedError('A single import may not exceed 20000 rows.');
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new ValidationFailedError('Every imported row must be an object.');
    }
  }
  return value as Record<string, unknown>[];
}

export function requireText(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationFailedError(`"${field}" must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new ValidationFailedError(`"${field}" must not exceed ${maxLength} characters.`);
  }
  return value;
}

export function optionalText(value: unknown, field: string, maxLength = 500): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationFailedError(`"${field}" must be a string.`);
  if (value.length > maxLength) throw new ValidationFailedError(`"${field}" must not exceed ${maxLength} characters.`);
  return value;
}

export function optionalInteger(value: unknown, field: string, max = 500): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ValidationFailedError(`"${field}" must be an integer between 0 and ${max}.`);
  }
  return value;
}

/**
 * Resolves a canonical record id from a URL segment. The client normally sends the typed
 * id key ("number:1" / "string:i-abc"); a bare id is accepted and inferred. Path
 * separators and traversal sequences can never survive this parse.
 */
export function parseRecordIdParam(raw: string): RecordId {
  const decoded = decodeURIComponent(raw);
  if (decoded.length === 0 || decoded.length > 200) {
    throw new ValidationFailedError('The record id is missing or too long.');
  }
  if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
    throw new ValidationFailedError('The record id must not contain a path separator.');
  }
  if (decoded === '.' || decoded === '..' || decoded.includes('..')) {
    throw new ValidationFailedError('The record id must not contain a traversal sequence.');
  }
  if (/^(number|string):/u.test(decoded)) return parseRecordIdKey(decoded);
  if (/^\d+$/u.test(decoded)) return Number(decoded);
  return decoded;
}

/** Self-declared workstation label; truncated and not authenticated. */
export function readClientLabel(request: IncomingMessage): string | null {
  const header = request.headers['x-tnp-client-label'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 64) || null;
}

export function readClientIp(request: IncomingMessage): string | null {
  return request.socket.remoteAddress ?? null;
}
