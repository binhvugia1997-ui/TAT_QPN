import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveContainedPath, resolveRealContainedPath, toSafeFileComponent } from '../../server/services/safePath';
import { StorageSecurityError } from '../../server/errors';
import { api, startTestServer } from './helpers';
import type { TestEnvironment } from './helpers';

let environment: TestEnvironment | undefined;
const scratch: string[] = [];

afterEach(async () => {
  await environment?.close();
  environment = undefined;
  for (const directory of scratch.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  }
});

/** Sends the request target exactly as written, with no client-side URL normalization. */
function rawGet(baseUrl: string, rawPath: string): Promise<number> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: url.hostname, port: url.port, path: rawPath, method: 'GET' },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function attachReport(env: TestEnvironment, idKey: string, fileName: string, contents: string) {
  return api(env.baseUrl, 'POST', `/api/records/${encodeURIComponent(idKey)}/report`, contents, {
    'X-TNP-File-Name': encodeURIComponent(fileName),
    'Content-Type': 'application/pdf',
  });
}

describe('managed report storage', () => {
  it('attaches a report to a canonical record id and streams it back', async () => {
    environment = await startTestServer();
    const attached = await attachReport(environment, 'number:50', 'Countermeasure.pdf', 'REPORT-BYTES');

    expect(attached.status).toBe(201);
    expect(attached.body).toMatchObject({ report: { originalName: 'Countermeasure.pdf', sizeBytes: 12 } });
    // The server-generated stored name and absolute path are never returned.
    expect(JSON.stringify(attached.body)).not.toContain(environment.paths.reportsDir);

    const response = await fetch(`${environment.baseUrl}/api/records/50/report`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(await response.text()).toBe('REPORT-BYTES');
  });

  it('does not treat the file name as record identity', async () => {
    environment = await startTestServer();
    await attachReport(environment, 'number:51', 'same-name.pdf', 'A');
    await attachReport(environment, 'number:52', 'same-name.pdf', 'B');

    const first = await fetch(`${environment.baseUrl}/api/records/51/report`);
    const second = await fetch(`${environment.baseUrl}/api/records/52/report`);

    expect(await first.text()).toBe('A');
    expect(await second.text()).toBe('B');
  });

  it('stores files under a server-generated name inside the managed directory', async () => {
    environment = await startTestServer();
    await attachReport(environment, 'number:53', '../../../etc/passwd', 'PAYLOAD');

    const files = readdirSync(environment.paths.reportsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('..');
    expect(files[0]).not.toContain(path.sep);
    expect(path.dirname(path.join(environment.paths.reportsDir, files[0]))).toBe(environment.paths.reportsDir);
  });

  it('replaces a report by relinking, leaving the previous bytes in place', async () => {
    environment = await startTestServer();
    await attachReport(environment, 'number:54', 'version-1.pdf', 'FIRST');
    await attachReport(environment, 'number:54', 'version-2.pdf', 'SECOND');

    const response = await fetch(`${environment.baseUrl}/api/records/54/report`);
    expect(await response.text()).toBe('SECOND');
    expect(readdirSync(environment.paths.reportsDir)).toHaveLength(2);
  });

  it('reports a missing file explicitly and never silently clears the link', async () => {
    environment = await startTestServer();
    await attachReport(environment, 'number:55', 'will-vanish.pdf', 'GONE-SOON');

    const stored = readdirSync(environment.paths.reportsDir)[0];
    rmSync(path.join(environment.paths.reportsDir, stored));

    const response = await api<{ error: string; message: string }>(environment.baseUrl, 'GET', '/api/records/55/report');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('report-unavailable');

    // The catalog entry survives so the operator can see the report is missing.
    expect(environment.context.reportCatalog.get('number:55')).toBeDefined();
    expect(environment.context.reportStorage.inspect('number:55').state).toBe('unavailable');
  });

  it('returns a clear state when no report was ever attached', async () => {
    environment = await startTestServer();
    expect(environment.context.reportStorage.inspect('number:56').state).toBe('no-report');

    const response = await api<{ error: string }>(environment.baseUrl, 'GET', '/api/records/56/report');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('report-unavailable');
  });

  it('unlinks a report but retains the stored bytes', async () => {
    environment = await startTestServer();
    await attachReport(environment, 'number:57', 'keep-bytes.pdf', 'RETAIN-ME');
    const before = readdirSync(environment.paths.reportsDir);

    const unlinked = await api<{ unlinked: boolean; retainedFileName: string }>(
      environment.baseUrl,
      'DELETE',
      '/api/records/57/report',
    );
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.unlinked).toBe(true);

    expect(readdirSync(environment.paths.reportsDir)).toEqual(before);
    expect(environment.context.reportCatalog.get('number:57')).toBeUndefined();
    expect(readFileSync(path.join(environment.paths.reportsDir, before[0]), 'utf8')).toBe('RETAIN-ME');
    expect(environment.context.reportCatalog.orphanedFiles()).toHaveLength(1);
  });

  it('audits attach, replace and unlink without storing file contents', async () => {
    environment = await startTestServer();
    await attachReport(environment, 'number:58', 'a.pdf', 'SECRET-CONTENT-A');
    await attachReport(environment, 'number:58', 'b.pdf', 'SECRET-CONTENT-B');
    await api(environment.baseUrl, 'DELETE', '/api/records/58/report');

    const { body } = await api<{ events: { operation: string }[] }>(
      environment.baseUrl,
      'GET',
      '/api/records/58/history',
    );
    const operations = body.events.map((event) => event.operation);
    expect(operations).toContain('report.attach');
    expect(operations).toContain('report.replace');
    expect(operations).toContain('report.unlink');

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('SECRET-CONTENT-A');
    expect(raw).not.toContain('SECRET-CONTENT-B');
  });

  it('refuses to attach a report to a record that does not exist', async () => {
    environment = await startTestServer();
    const response = await attachReport(environment, 'number:999999', 'orphan.pdf', 'X');
    expect(response.status).toBe(404);
    expect(readdirSync(environment.paths.reportsDir)).toHaveLength(0);
  });

  it('indexes attached reports in bulk for the Records QPN column', async () => {
    environment = await startTestServer();

    const empty = await api<{ reports: unknown[] }>(environment.baseUrl, 'GET', '/api/report-index');
    expect(empty.status).toBe(200);
    expect(empty.body.reports).toEqual([]);

    await attachReport(environment, 'number:50', 'Countermeasure.pdf', 'REPORT-A');
    await attachReport(environment, 'number:51', 'Evidence.xlsx', 'REPORT-B');

    const indexed = await api<{ reports: { recordIdKey: string; originalName: string; sizeBytes: number }[] }>(
      environment.baseUrl,
      'GET',
      '/api/report-index',
    );

    expect(indexed.status).toBe(200);
    expect(indexed.body.reports.map(({ recordIdKey, originalName, sizeBytes }) => ({ recordIdKey, originalName, sizeBytes })))
      .toEqual([
        { recordIdKey: 'number:50', originalName: 'Countermeasure.pdf', sizeBytes: 8 },
        { recordIdKey: 'number:51', originalName: 'Evidence.xlsx', sizeBytes: 8 },
      ]);
    // Server-side stored names and absolute paths never leave through the index either.
    expect(JSON.stringify(indexed.body)).not.toContain(environment.paths.reportsDir);
    // Stored names look like "<record id key>--<random hex>--<original>"; the random part must not leak.
    expect(JSON.stringify(indexed.body)).not.toMatch(/--[0-9a-f]{12}--/iu);
    expect(JSON.stringify(indexed.body)).not.toContain('storedName');

    // Unlinking removes the row from the index but keeps the stored bytes.
    expect((await api(environment.baseUrl, 'DELETE', '/api/records/number%3A50/report')).status).toBe(200);
    const afterUnlink = await api<{ reports: { recordIdKey: string }[] }>(
      environment.baseUrl,
      'GET',
      '/api/report-index',
    );
    expect(afterUnlink.body.reports.map(({ recordIdKey }) => recordIdKey)).toEqual(['number:51']);
  });

  it('only answers the report index for GET', async () => {
    environment = await startTestServer();
    expect((await api(environment.baseUrl, 'POST', '/api/report-index', {})).status).toBe(404);
  });
});

describe('report path security', () => {
  it('rejects directory traversal in a stored name', () => {
    expect(() => resolveContainedPath('/srv/reports', '../secret.pdf')).toThrow(StorageSecurityError);
    expect(() => resolveContainedPath('/srv/reports', '..')).toThrow(StorageSecurityError);
    expect(() => resolveContainedPath('/srv/reports', 'sub/../secret.pdf')).toThrow(StorageSecurityError);
  });

  it('rejects encoded traversal before any handler runs', async () => {
    environment = await startTestServer();
    // fetch() would normalize these client-side, so the raw target is sent verbatim.
    for (const route of [
      '/api/records/%2e%2e%2f%2e%2e%2fetc/report',
      '/api/records/..%2F..%2Fetc/report',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/api/records/%252e%252e/report',
    ]) {
      const status = await rawGet(environment.baseUrl, route);
      expect([400, 403, 404], route).toContain(status);
    }
  });

  it('rejects absolute external paths', () => {
    expect(() => resolveContainedPath('/srv/reports', '/etc/passwd')).toThrow(StorageSecurityError);
    expect(() => resolveContainedPath('/srv/reports', 'C:\\Windows\\win.ini')).toThrow(StorageSecurityError);
    expect(() => resolveContainedPath('/srv/reports', '\\\\server\\share\\file')).toThrow(StorageSecurityError);
  });

  it('rejects a file symlink that escapes managed storage', async () => {
    environment = await startTestServer();
    const outside = path.join(tmpdir(), `tnp-outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    scratch.push(outside);
    const secret = path.join(outside, 'secret.txt');
    writeFileSync(secret, 'TOP-SECRET');

    const linkName = 'escape.pdf';
    symlinkSync(secret, path.join(environment.paths.reportsDir, linkName));

    // Point the catalog at the symlink exactly as an attacker-controlled row would.
    environment.context.reportCatalog.upsert({
      recordIdKey: 'number:60',
      storedName: linkName,
      originalName: 'escape.pdf',
      contentType: 'text/plain',
      sizeBytes: 10,
      attachedAt: new Date().toISOString(),
    });

    expect(() => resolveRealContainedPath(environment.paths.reportsDir, linkName)).toThrow(StorageSecurityError);

    const response = await api<{ error: string }>(environment.baseUrl, 'GET', '/api/records/60/report');
    expect([403, 404]).toContain(response.status);
    if (response.status === 403) expect(response.body.error).toBe('forbidden-path');
  });

  it('rejects a directory symlink used to reach outside managed storage', async () => {
    environment = await startTestServer();
    const outside = path.join(tmpdir(), `tnp-outside-dir-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    scratch.push(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');

    symlinkSync(outside, path.join(environment.paths.reportsDir, 'linked-dir'));

    // Any attempt to address a file through the symlinked directory is refused, because a
    // stored name may not contain a path separator at all.
    expect(() => resolveContainedPath(environment.paths.reportsDir, 'linked-dir/secret.txt'))
      .toThrow(StorageSecurityError);

    environment.context.reportCatalog.upsert({
      recordIdKey: 'number:61',
      storedName: 'linked-dir/secret.txt',
      originalName: 'secret.txt',
      contentType: 'text/plain',
      sizeBytes: 10,
      attachedAt: new Date().toISOString(),
    });

    const response = await api<{ error: string }>(environment.baseUrl, 'GET', '/api/records/61/report');
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden-path');
  });

  it('offers no general filesystem browsing endpoint', async () => {
    environment = await startTestServer();
    for (const route of ['/api/files', '/api/fs', '/api/reports', '/api/directory', '/api/exec']) {
      const response = await api(environment.baseUrl, 'GET', route);
      expect(response.status).toBe(404);
    }
  });

  it('sanitizes file-name components for Windows and POSIX', () => {
    expect(toSafeFileComponent('../../evil.pdf')).not.toContain('..');
    expect(toSafeFileComponent('a/b\\c.pdf')).not.toMatch(/[\\/]/u);
    expect(toSafeFileComponent('normal report.pdf')).toMatch(/^[A-Za-z0-9._ -]+$/u);
    expect(toSafeFileComponent('')).toBe('file');
  });

  it('refuses an empty report upload', async () => {
    environment = await startTestServer();
    const response = await attachReport(environment, 'number:62', 'empty.pdf', '');
    expect(response.status).toBe(404);
    expect(existsSync(environment.paths.reportsDir)).toBe(true);
  });
});
