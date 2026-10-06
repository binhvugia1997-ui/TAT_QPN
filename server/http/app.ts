import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { findExistingRecord, getRecordFingerprint } from '../../src/business/duplicate/identity';
import { getRecordIdKey } from '../../src/business/records/recordKey';
import { RecordNormalizationError, assertRecordIdUnchanged, normalizeDefectRecord, normalizeDefectRecordPatch } from '../../src/models/defect-record';
import { buildManualRecord } from '../../src/services/records/recordService';
import type { DefectRecord, DefectRecordPatch } from '../../src/models/defect-record';
import type { AppContext } from '../context';
import { DuplicateRecordError, HttpError, RecordConflictError, RecordNotFoundError, StorageSecurityError, ValidationFailedError } from '../errors';
import { describePath } from '../paths';
import { getLanAddresses } from '../lan';
import { diffRecords, toApiRecord } from '../db/records';
import { PayloadTooLargeError, readBody, readClientIp, readClientLabel, readJsonBody, requireObject, requireRows, requireText, optionalText, optionalInteger, parseRecordIdParam, MAX_UPLOAD_BODY_BYTES } from './validation';
import { resolveContainedPath } from '../services/safePath';

export interface HttpAppOptions {
  context: AppContext;
  /** Serve the built browser app when present; pass null to expose the API only. */
  staticDir?: string | null;
}

/** Loopback only; a LAN address must never receive a host filesystem path. */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/u, '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
  'Cache-Control': 'no-store',
};

const STATIC_EXTENSIONS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function createHttpServer(options: HttpAppOptions): http.Server {
  const { context } = options;
  const staticDir = options.staticDir === undefined ? context.paths.staticDir : options.staticDir;

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = (request.method ?? 'GET').toUpperCase();

    // Reject encoded traversal before it reaches any handler.
    if (request.url && /%2e%2e|%252e|%2f|%5c/iu.test(request.url)) {
      throw new StorageSecurityError('The request path contains an encoded traversal sequence.');
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await handleApi(method, url, request, response);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(405, 'method-not-allowed', 'Only GET is supported outside the API.');
    }
    serveStatic(url, request, response, staticDir);
  }

  async function handleApi(
    method: string,
    url: URL,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    const actor = { clientIp: readClientIp(request), clientLabel: readClientLabel(request) };

    // GET /api/status
    if (segments.length === 2 && segments[1] === 'status' && method === 'GET') {
      sendJson(response, 200, buildStatus());
      return;
    }

    // GET /api/bootstrap
    if (segments.length === 2 && segments[1] === 'bootstrap' && method === 'GET') {
      sendJson(response, 200, {
        seed: context.seed,
        schemaVersion: context.database.userVersion,
        recordCount: context.records.count(),
        status: buildStatus(),
      });
      return;
    }

    // GET /api/records
    if (segments.length === 2 && segments[1] === 'records' && method === 'GET') {
      sendJson(response, 200, { records: context.records.listRecords() });
      return;
    }

    // POST /api/records
    if (segments.length === 2 && segments[1] === 'records' && method === 'POST') {
      const body = await readJsonBody<{ record?: unknown }>(request);
      const created = createRecord(requireObject(body.record, 'record'), actor);
      sendJson(response, 201, { record: toApiRecord(created) });
      return;
    }

    // /api/import-history
    if (segments.length === 2 && segments[1] === 'import-history' && method === 'GET') {
      sendJson(response, 200, { history: context.importHistory.list() });
      return;
    }

    // /api/import/preview | /api/import/commit
    if (segments.length === 3 && segments[1] === 'import' && method === 'POST') {
      const body = await readJsonBody<{ rows?: unknown; fileName?: unknown }>(request);
      const rows = requireRows(body.rows);
      const fileName = requireText(body.fileName, 'fileName', 300);
      if (segments[2] === 'preview') {
        sendJson(response, 200, context.imports.preview(rows, fileName));
        return;
      }
      if (segments[2] === 'commit') {
        const result = await context.imports.commit(rows, { fileName, actor });
        sendJson(response, 200, result);
        return;
      }
      throw new HttpError(404, 'not-found', `Unknown import action "${segments[2]}".`);
    }

    // /api/audit
    if (segments.length === 2 && segments[1] === 'audit' && method === 'GET') {
      sendJson(response, 200, {
        events: context.audit.list({
          limit: optionalInteger(numberOrNull(url.searchParams.get('limit')), 'limit', 500),
          operation: optionalText(url.searchParams.get('operation') ?? undefined, 'operation', 60),
          from: optionalText(url.searchParams.get('from') ?? undefined, 'from', 40),
          to: optionalText(url.searchParams.get('to') ?? undefined, 'to', 40),
        }),
      });
      return;
    }

    // /api/backups
    if (segments.length === 2 && segments[1] === 'backups' && method === 'GET') {
      sendJson(response, 200, {
        backups: context.backups.list(),
        directory: describePath(context.paths, context.backups.directory),
      });
      return;
    }
    if (segments.length === 2 && segments[1] === 'backups' && method === 'POST') {
      const body = await readJsonBody<{ note?: unknown }>(request);
      const entry = await context.backups.create('manual', optionalText(body.note, 'note', 200) ?? 'Manual snapshot');
      context.audit.append({ operation: 'backup.manual', details: { fileName: entry.fileName }, ...actor });
      sendJson(response, 201, entry);
      return;
    }

    // /api/records/:id[...]
    if (segments.length >= 3 && segments[1] === 'records') {
      const id = parseRecordIdParam(segments[2]);
      const idKey = getRecordIdKey(id);

      if (segments.length === 3) {
        if (method === 'GET') {
          const stored = context.records.getStored(idKey);
          if (!stored) throw new RecordNotFoundError(idKey);
          sendJson(response, 200, { record: toApiRecord(stored) });
          return;
        }
        if (method === 'PATCH') {
          const body = await readJsonBody<{ patch?: unknown; expectedVersion?: unknown }>(request);
          const updated = updateRecord(idKey, requireObject(body.patch, 'patch'), body.expectedVersion, actor);
          sendJson(response, 200, { record: toApiRecord(updated) });
          return;
        }
        if (method === 'DELETE') {
          deleteRecord(idKey, actor);
          sendJson(response, 200, { deleted: true, idKey });
          return;
        }
      }

      if (segments.length === 4 && segments[3] === 'history' && method === 'GET') {
        sendJson(response, 200, {
          events: context.audit.list({
            recordIdKey: idKey,
            limit: optionalInteger(numberOrNull(url.searchParams.get('limit')), 'limit', 500),
          }),
        });
        return;
      }

      /**
       * Resolves a record's managed report to a real filesystem path so the owner desktop
       * can hand it to the Windows default application. Doubly gated: the server must have
       * been started by the desktop wrapper, and the connection must be loopback, so a LAN
       * client can never obtain a host path. Phase 5 containment and symlink checks still
       * run through `reportStorage.open`.
       */
      if (segments.length === 4 && segments[3] === 'report-path' && method === 'GET') {
        if (!context.config.desktopBridge) {
          throw new HttpError(404, 'not-found', 'The managed-report path lookup is only available to the owner desktop.');
        }
        if (!isLoopbackAddress(request.socket.remoteAddress)) {
          throw new StorageSecurityError('The managed-report path lookup is restricted to the local machine.');
        }
        const resolved = context.reportStorage.open(idKey);
        sendJson(response, 200, {
          absolutePath: resolved.filePath,
          originalName: resolved.link.originalName,
          sizeBytes: resolved.sizeBytes,
        });
        return;
      }

      // Metadata and availability only; the plain GET streams the bytes.
      if (segments.length === 4 && segments[3] === 'report-info' && method === 'GET') {
        const inspected = context.reportStorage.inspect(idKey);
        sendJson(response, 200, {
          state: inspected.state,
          report: inspected.state === 'no-report' ? null : publicReport(inspected.link),
        });
        return;
      }

      if (segments.length === 4 && segments[3] === 'report') {
        if (method === 'GET') {
          streamReport(idKey, response);
          return;
        }
        if (method === 'POST') {
          const link = await attachReport(idKey, request, actor);
          sendJson(response, 201, { report: publicReport(link) });
          return;
        }
        if (method === 'DELETE') {
          const removed = context.reportStorage.unlink(idKey);
          if (!removed) throw new RecordNotFoundError(`No report is linked to "${idKey}".`);
          context.audit.append({
            operation: 'report.unlink',
            recordIdKey: idKey,
            changes: [{ field: 'report', oldValue: removed.originalName, newValue: null }],
            details: { storedBytesRetained: true },
            ...actor,
          });
          sendJson(response, 200, { unlinked: true, retainedFileName: removed.originalName });
          return;
        }
      }
    }

    throw new HttpError(404, 'not-found', `No API route for ${method} ${url.pathname}.`);
  }

  /**
   * The status endpoint reports the live socket, so a server started on an ephemeral port
   * or on a different interface than configured still describes itself accurately.
   */
  function currentSocket(): { address: string; port: number } {
    const bound = server.address();
    if (bound && typeof bound === 'object') return { address: bound.address, port: bound.port };
    return { address: context.config.bindHost, port: context.config.port };
  }

  function buildStatus() {
    const socket = currentSocket();
    const actualPort = socket.port;
    const lanAddresses = context.config.lanEnabled ? getLanAddresses(actualPort) : [];
    return {
      app: 'TNP Defect Management System',
      phase: 5,
      storage: 'sqlite',
      server: {
        bindAddress: socket.address,
        configuredBindHost: context.config.bindHost,
        actualPort,
        lanEnabled: context.config.lanEnabled,
        lanAddresses,
        localhostUrl: `http://127.0.0.1:${actualPort}`,
        lanEnabledNote: context.config.lanEnabled
          ? 'LAN mode is on: any workstation on this network can read and write records.'
          : 'LAN mode is off: only this machine can reach the server.',
        configSources: context.config.sources,
      },
      database: {
        path: describePath(context.paths, context.paths.databaseFile),
        schemaVersion: context.database.userVersion,
        recordCount: context.records.count(),
        auditEventCount: context.audit.count(),
      },
      directories: {
        data: describePath(context.paths, context.paths.dataDir),
        backups: describePath(context.paths, context.paths.backupsDir),
        reports: describePath(context.paths, context.paths.reportsDir),
      },
      seed: context.seed,
      migrations: context.migrations,
      security: {
        authentication: false,
        tls: false,
        warning: context.config.lanEnabled
          ? 'LAN mode has no authentication and no TLS. Only use it on a trusted internal network, and allow the app through the Windows Private-network firewall if other PCs cannot connect.'
          : 'The server is bound to localhost only. LAN access is disabled.',
      },
      startedAt: context.startedAt,
    };
  }

  function createRecord(input: Record<string, unknown>, actor: typeof emptyActor) {
    const record = buildManualRecord(input);
    assertNoDuplicate(record, context.records.listRecords().filter((existing) => getRecordIdKey(existing.id) !== getRecordIdKey(record.id)));
    const stored = context.records.insertNormalized(record);
    context.audit.append({
      operation: 'record.create',
      recordIdKey: stored.idKey,
      mgmtNo: String(record.mgmtNo ?? ''),
      changes: [{ field: '(new record)', oldValue: null, newValue: record.mgmtNo ?? null }],
      ...actor,
    });
    return stored;
  }

  function updateRecord(
    idKey: string,
    patch: Record<string, unknown>,
    expectedVersion: unknown,
    actor: typeof emptyActor,
  ) {
    const stored = context.records.getStored(idKey);
    if (!stored) throw new RecordNotFoundError(idKey);
    assertRecordIdUnchanged(stored.record.id, patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'recordSource')) {
      throw new ValidationFailedError('Record provenance cannot be changed by an edit.');
    }
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion)) {
      throw new ValidationFailedError('"expectedVersion" is required so concurrent edits cannot be overwritten silently.');
    }

    const normalizedPatch = normalizeDefectRecordPatch(patch) as DefectRecordPatch;
    const next = normalizeDefectRecord(
      { ...stored.record, ...normalizedPatch, id: stored.record.id, recordSource: stored.record.recordSource },
      stored.record.recordSource,
    );

    const others = context.records.listRecords().filter((record) => getRecordIdKey(record.id) !== idKey);
    assertNoDuplicate(next, others);

    const updated = context.records.update(idKey, next, expectedVersion);
    context.audit.append({
      operation: 'record.update',
      recordIdKey: idKey,
      mgmtNo: String(next.mgmtNo ?? ''),
      changes: diffRecords(stored.record, next),
      ...actor,
    });
    return updated;
  }

  function deleteRecord(idKey: string, actor: typeof emptyActor) {
    const stored = context.records.getStored(idKey);
    if (!stored) throw new RecordNotFoundError(idKey);
    context.records.remove(idKey);
    context.audit.append({
      operation: 'record.delete',
      recordIdKey: idKey,
      mgmtNo: String(stored.record.mgmtNo ?? ''),
      changes: [{ field: '(record)', oldValue: stored.record.mgmtNo ?? null, newValue: null }],
      ...actor,
    });
  }

  async function attachReport(
    idKey: string,
    request: http.IncomingMessage,
    actor: typeof emptyActor,
  ) {
    const stored = context.records.getStored(idKey);
    if (!stored) throw new RecordNotFoundError(idKey);

    const rawName = request.headers['x-tnp-file-name'];
    const headerName = Array.isArray(rawName) ? rawName[0] : rawName;
    if (!headerName) throw new ValidationFailedError('The "X-TNP-File-Name" header is required when attaching a report.');

    let originalName: string;
    try {
      originalName = decodeURIComponent(headerName);
    } catch {
      originalName = headerName;
    }

    const contents = await readBody(request, MAX_UPLOAD_BODY_BYTES);
    const previous = context.reportCatalog.get(idKey);
    const link = context.reportStorage.attach(idKey, {
      originalName,
      contentType: typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : null,
      contents: new Uint8Array(contents),
    });

    context.audit.append({
      operation: previous ? 'report.replace' : 'report.attach',
      recordIdKey: idKey,
      mgmtNo: String(stored.record.mgmtNo ?? ''),
      changes: [{ field: 'report', oldValue: previous?.originalName ?? null, newValue: link.originalName }],
      details: { sizeBytes: link.sizeBytes },
      ...actor,
    });

    return link;
  }

  function streamReport(idKey: string, response: http.ServerResponse) {
    const { link, filePath, sizeBytes } = context.reportStorage.open(idKey);
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': link.contentType ?? 'application/octet-stream',
      'Content-Length': String(sizeBytes),
      'Content-Disposition': `inline; filename="${encodeURIComponent(link.originalName)}"`,
    });
    fs.createReadStream(filePath).pipe(response);
  }

  function publicReport(link: { originalName: string; sizeBytes: number; attachedAt: string; updatedAt: string; contentType: string | null }) {
    // Stored names and absolute paths stay server-side.
    return {
      originalName: link.originalName,
      sizeBytes: link.sizeBytes,
      contentType: link.contentType,
      attachedAt: link.attachedAt,
      updatedAt: link.updatedAt,
    };
  }

  function serveStatic(
    url: URL,
    request: http.IncomingMessage,
    response: http.ServerResponse,
    directory: string | null,
  ) {
    if (!directory || !fs.existsSync(path.join(directory, 'index.html'))) {
      sendJson(response, 200, {
        ...buildStatus(),
        notice: 'The browser bundle is not built yet. Run "npm run build", or use the Vite dev server.',
      });
      return;
    }

    const requested = decodeURIComponent(url.pathname);
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    let target: string;
    try {
      target = resolveContainedPath(directory, relative);
    } catch {
      // Unknown deep links fall back to the SPA entry point.
      target = path.join(directory, 'index.html');
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      target = path.join(directory, 'index.html');
    }

    const extension = path.extname(target).toLowerCase();
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': STATIC_EXTENSIONS[extension] ?? 'application/octet-stream',
      'Content-Length': String(fs.statSync(target).size),
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(target).pipe(response);
  }

  return server;
}

const emptyActor = { clientIp: null as string | null, clientLabel: null as string | null };

function assertNoDuplicate(candidate: DefectRecord, others: readonly DefectRecord[]): void {
  const existing = findExistingRecord(candidate, others);
  if (existing) {
    throw new DuplicateRecordError(getRecordIdKey(existing.id), getRecordFingerprint(candidate));
  }
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response: http.ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }

  if (error instanceof RecordConflictError) {
    sendJson(response, 409, {
      error: 'conflict',
      message: 'This record was changed by someone else. Reload it and review the current values before saving again.',
      idKey: error.idKey,
      expectedVersion: error.expectedVersion,
      currentVersion: error.currentVersion,
    });
    return;
  }
  if (error instanceof RecordNotFoundError) {
    sendJson(response, 404, { error: 'record-not-found', message: error.message });
    return;
  }
  if (error instanceof PayloadTooLargeError) {
    sendJson(response, 413, { error: 'payload-too-large', message: error.message });
    return;
  }
  if (error instanceof RecordNormalizationError) {
    sendJson(response, 400, { error: 'validation-failed', message: error.message, field: error.field });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: error.code, message: error.message, details: error.details });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, 500, { error: 'server-error', message });
}

function numberOrNull(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
