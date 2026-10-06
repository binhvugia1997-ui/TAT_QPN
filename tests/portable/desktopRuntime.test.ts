import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isLoopbackAddress } from '../../server/http/app';
import { checkManagedReportPath } from '../../desktop/main/bridgeCore';
import { api, startTestServer } from '../server/helpers';
import type { TestEnvironment } from '../server/helpers';

let environment: TestEnvironment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

async function attachReport(env: TestEnvironment, id: string, fileName: string, contents: string) {
  return api(env.baseUrl, 'POST', `/api/records/${encodeURIComponent(id)}/report`, contents, {
    'X-TNP-File-Name': encodeURIComponent(fileName),
    'Content-Type': 'application/pdf',
  });
}

describe('loopback address check', () => {
  it('accepts only the local machine', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects LAN and absent addresses', () => {
    expect(isLoopbackAddress('192.168.1.42')).toBe(false);
    expect(isLoopbackAddress('169.254.0.21')).toBe(false);
    expect(isLoopbackAddress('10.0.0.7')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});

describe('managed-report path lookup for the native bridge', () => {
  it('is absent unless the server was started by the desktop wrapper', async () => {
    environment = await startTestServer();
    await attachReport(environment, '50', 'Countermeasure.pdf', 'REPORT-BYTES');

    const response = await api(environment.baseUrl, 'GET', '/api/records/50/report-path');
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).toContain('only available to the owner desktop');
    // No host path may leak from a plain server run.
    expect(JSON.stringify(response.body)).not.toContain(environment.paths.reportsDir);
  });

  it('returns a path inside managed storage when the bridge is enabled', async () => {
    environment = await startTestServer({ env: { TNP_DESKTOP_BRIDGE: '1' } });
    await attachReport(environment, '50', 'Countermeasure.pdf', 'REPORT-BYTES');

    const response = await api<{ absolutePath: string; originalName: string; sizeBytes: number }>(
      environment.baseUrl,
      'GET',
      '/api/records/50/report-path',
    );

    expect(response.status).toBe(200);
    expect(response.body.originalName).toBe('Countermeasure.pdf');
    expect(response.body.sizeBytes).toBe(12);
    expect(path.isAbsolute(response.body.absolutePath)).toBe(true);
    expect(response.body.absolutePath.startsWith(environment.paths.reportsDir)).toBe(true);

    // The path is the real stored file, and the desktop-side check accepts it.
    expect(readFileSync(response.body.absolutePath, 'utf8')).toBe('REPORT-BYTES');
    expect(checkManagedReportPath(response.body.absolutePath, environment.paths.reportsDir).allowed).toBe(true);
  });

  it('reports a missing report rather than inventing a path', async () => {
    environment = await startTestServer({ env: { TNP_DESKTOP_BRIDGE: '1' } });
    const response = await api(environment.baseUrl, 'GET', '/api/records/77/report-path');
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(environment.paths.reportsDir);
  });

  it('does not expose the path through the plain report-info endpoint', async () => {
    environment = await startTestServer({ env: { TNP_DESKTOP_BRIDGE: '1' } });
    await attachReport(environment, '50', 'Countermeasure.pdf', 'REPORT-BYTES');

    const info = await api(environment.baseUrl, 'GET', '/api/records/50/report-info');
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ state: 'attached', report: { originalName: 'Countermeasure.pdf' } });
    expect(JSON.stringify(info.body)).not.toContain(environment.paths.reportsDir);
  });

  it('stores the file inside managed storage with a server-generated name', async () => {
    environment = await startTestServer({ env: { TNP_DESKTOP_BRIDGE: '1' } });
    await attachReport(environment, '50', 'Countermeasure.pdf', 'REPORT-BYTES');

    const stored = readdirSync(environment.paths.reportsDir);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toBe('Countermeasure.pdf');
    expect(stored[0]).toContain('number_50');
  });
});
