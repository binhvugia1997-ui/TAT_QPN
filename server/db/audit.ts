import type { DefectRecord } from '../../src/models/defect-record';
import type { FieldChange } from './records';
import type { SqlValue } from './connection';
import type { SqliteDatabase } from './connection';

export type AuditOperation =
  | 'record.create'
  | 'record.update'
  | 'record.delete'
  | 'import.commit'
  | 'report.attach'
  | 'report.replace'
  | 'report.unlink'
  | 'backup.daily'
  | 'backup.pre-import'
  | 'backup.manual'
  | 'migration.apply';

export interface AuditActor {
  /** Transport-level client address. It identifies a connection, not a human being. */
  clientIp?: string | null;
  /** Optional, self-declared workstation label supplied by the client. Not authenticated. */
  clientLabel?: string | null;
}

export interface AuditEventInput extends AuditActor {
  operation: AuditOperation;
  occurredAt?: string;
  record?: Pick<DefectRecord, 'id' | 'mgmtNo'> & { id?: unknown };
  recordIdKey?: string | null;
  mgmtNo?: string | null;
  importBatchId?: string | null;
  changes?: readonly FieldChange[];
  details?: Record<string, unknown> | null;
}

export interface AuditEvent extends AuditActor {
  seq: number;
  occurredAt: string;
  operation: string;
  recordIdKey: string | null;
  mgmtNo: string | null;
  importBatchId: string | null;
  changes: FieldChange[];
  details: Record<string, unknown>;
}

export interface AuditQuery {
  limit?: number;
  recordIdKey?: string;
  operation?: string;
  from?: string;
  to?: string;
}

const MAX_TEXT = 4000;
const MAX_LABEL_LENGTH = 64;

/**
 * History is shared with LAN clients, so anything that looks like an absolute host path is
 * replaced with its file name. Report bytes never enter the audit trail.
 */
export function redactPathLike(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const looksAbsolute = /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('/') || value.startsWith('\\\\');
  if (!looksAbsolute) return value;
  const parts = value.split(/[\\/]+/u).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = typeof value === 'string'
      ? redactPathLike(value)
      : value !== null && typeof value === 'object' && !Array.isArray(value)
        ? redactObject(value as Record<string, unknown>)
        : value;
  }
  return output;
}

function clip(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

function sanitizeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  // A free-text label is truncated and stripped of control characters before storage.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, MAX_LABEL_LENGTH);
  return cleaned || null;
}

function sanitizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/^::ffff:/u, '');
  return /^[0-9a-fA-F.:]+$/u.test(normalized) ? normalized : null;
}

interface AuditRow {
  seq: number;
  occurred_at: string;
  operation: string;
  record_id_key: string | null;
  mgmt_no: string | null;
  import_batch_id: string | null;
  client_ip: string | null;
  client_label: string | null;
  changes_json: string | null;
  details_json: string | null;
}

export class AuditStore {
  constructor(private readonly database: SqliteDatabase) {}

  /** Append-only. One call covers every field changed by a single operation. */
  append(event: AuditEventInput): AuditEvent {
    const changes = (event.changes ?? []).map((change) => ({
      field: change.field,
      oldValue: redactPathLike(change.oldValue),
      newValue: redactPathLike(change.newValue),
    }));
    const details = event.details ? redactObject(event.details) : {};
    const recordIdKey = event.recordIdKey ?? null;
    const mgmtNo = event.mgmtNo ?? null;

    const result = this.database.run(
      `INSERT INTO audit_events (
         occurred_at, operation, record_id_key, mgmt_no, import_batch_id,
         client_ip, client_label, changes_json, details_json
       ) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        event.occurredAt ?? new Date().toISOString(),
        event.operation,
        recordIdKey,
        mgmtNo,
        event.importBatchId ?? null,
        sanitizeIp(event.clientIp),
        sanitizeLabel(event.clientLabel),
        changes.length > 0 ? clip(JSON.stringify(changes)) : null,
        Object.keys(details).length > 0 ? clip(JSON.stringify(details)) : null,
      ] satisfies SqlValue[],
    );

    return {
      seq: Number(result.lastInsertRowid),
      occurredAt: event.occurredAt ?? new Date().toISOString(),
      operation: event.operation,
      recordIdKey,
      mgmtNo,
      importBatchId: event.importBatchId ?? null,
      clientIp: sanitizeIp(event.clientIp),
      clientLabel: sanitizeLabel(event.clientLabel),
      changes,
      details,
    };
  }

  private hydrate(row: AuditRow): AuditEvent {
    return {
      seq: row.seq,
      occurredAt: row.occurred_at,
      operation: row.operation,
      recordIdKey: row.record_id_key,
      mgmtNo: row.mgmt_no,
      importBatchId: row.import_batch_id,
      clientIp: row.client_ip,
      clientLabel: row.client_label,
      changes: parseJsonArray<FieldChange>(row.changes_json),
      details: parseJsonObject(row.details_json),
    };
  }

  list(query: AuditQuery = {}): AuditEvent[] {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const clauses: string[] = [];
    const params: SqlValue[] = [];

    if (query.recordIdKey) {
      clauses.push('record_id_key = ?');
      params.push(query.recordIdKey);
    }
    if (query.operation) {
      clauses.push('operation = ?');
      params.push(query.operation);
    }
    if (query.from) {
      clauses.push('occurred_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      clauses.push('occurred_at <= ?');
      params.push(query.to);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.all<AuditRow>(
      `SELECT * FROM audit_events ${where} ORDER BY seq DESC LIMIT ?`,
      [...params, limit],
    );
    return rows.map((row) => this.hydrate(row));
  }

  count(): number {
    return this.database.get<{ total: number }>('SELECT COUNT(*) AS total FROM audit_events')?.total ?? 0;
  }
}

function parseJsonArray<T>(value: string | null): T[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
