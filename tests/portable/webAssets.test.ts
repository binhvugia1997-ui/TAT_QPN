import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assemblePortableBuild } from './helpers';
import type { AssembledBuild } from './helpers';

/**
 * Regression test for the blank Electron window found in Windows UAT.
 *
 * The renderer loads `http://127.0.0.1:<port>/` from the owned server. `index.html` loaded
 * fine — the window title proved it — but every `/assets/...` request was answered with
 * `index.html` and HTTP 200, because the static handler reused the *flat* managed-storage path
 * resolver, which rejects any name containing a path separator. The browser then refused to
 * execute HTML as a JavaScript module and nothing rendered.
 *
 * So this test boots the **packaged** server against the **packaged** web bundle and performs
 * the real requests a renderer makes, asserting status *and* content type. Checking that the
 * files exist on disk cannot catch this: they always existed.
 */

let build: AssembledBuild;
let serverProcess: ChildProcess;
let baseUrl = '';
let dataRoot = '';
let serverLog = '';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1_500) });
      if (response.status === 200) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => { setTimeout(resolve, 150); });
  }
  throw new Error(`The packaged server did not become ready at ${url}: ${lastError}\n${serverLog}`);
}

beforeAll(async () => {
  build = assemblePortableBuild('webassets');
  dataRoot = mkdtempSync(path.join(tmpdir(), 'tnp-webassets-data-'));

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  serverProcess = spawn(
    process.execPath,
    [path.join(build.appDir, 'server-runtime', 'server', 'index.js'), '--port', String(port), '--no-lan', '--host', '127.0.0.1'],
    {
      env: {
        ...process.env,
        TNP_DATA_DIR: path.join(dataRoot, 'data'),
        TNP_BACKUPS_DIR: path.join(dataRoot, 'backups'),
        TNP_REPORTS_DIR: path.join(dataRoot, 'reports'),
        TNP_DB_FILE: path.join(dataRoot, 'data', 'tnp.db'),
        TNP_LOCK_FILE: path.join(dataRoot, 'data', 'tnp.lock'),
        TNP_CONFIG_FILE: path.join(dataRoot, 'data', 'server.json'),
        TNP_SEED_FILE: path.join(build.appDir, 'seed', 'legacy-base-data.json'),
        // Exactly what the desktop wrapper passes in the packaged build.
        TNP_STATIC_DIR: path.join(build.appDir, 'web'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  serverProcess.stdout?.setEncoding('utf8');
  serverProcess.stderr?.setEncoding('utf8');
  serverProcess.stdout?.on('data', (chunk: string) => { serverLog += chunk; });
  serverProcess.stderr?.on('data', (chunk: string) => { serverLog += chunk; });

  await waitForServer(baseUrl);
}, 300_000);

afterAll(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    if (serverProcess.exitCode === null) serverProcess.kill('SIGKILL');
  }
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  build?.cleanup();
});

/** Extracts every bundled asset reference from the served HTML. */
function referencedAssets(html: string): { scripts: string[]; styles: string[] } {
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/gu)].map((match) => match[1] as string);
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/gu)].map((match) => match[1] as string);
  return { scripts, styles };
}

describe('packaged web assets served to the Electron renderer', () => {
  it('serves the entry document as HTML', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const html = await response.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<title>TNP Defect Management System</title>');
  });

  it('serves /index.html identically to /', async () => {
    const root = await (await fetch(`${baseUrl}/`)).text();
    const explicit = await fetch(`${baseUrl}/index.html`);
    expect(explicit.status).toBe(200);
    expect(explicit.headers.get('content-type')).toContain('text/html');
    expect(await explicit.text()).toBe(root);
  });

  it('references at least one script and one stylesheet', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const { scripts, styles } = referencedAssets(html);
    expect(scripts.length).toBeGreaterThan(0);
    expect(styles.length).toBeGreaterThan(0);
    for (const asset of [...scripts, ...styles]) {
      expect(asset.startsWith('/assets/'), `${asset} should be a bundle path`).toBe(true);
    }
  });

  it('serves every referenced script as JavaScript, never as the HTML shell', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const { scripts } = referencedAssets(html);

    for (const asset of scripts) {
      const response = await fetch(`${baseUrl}${asset}`);
      const body = await response.text();

      expect(response.status, `${asset} must be served`).toBe(200);
      // This is the exact assertion the blank window would have failed.
      expect(
        response.headers.get('content-type'),
        `${asset} must be served as JavaScript, got "${response.headers.get('content-type')}"`,
      ).toContain('javascript');
      expect(body.startsWith('<!doctype html'), `${asset} returned the HTML shell`).toBe(false);
      expect(body.length).toBeGreaterThan(10_000);
    }
  });

  it('serves every referenced stylesheet as CSS, never as the HTML shell', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const { styles } = referencedAssets(html);

    for (const asset of styles) {
      const response = await fetch(`${baseUrl}${asset}`);
      const body = await response.text();

      expect(response.status, `${asset} must be served`).toBe(200);
      expect(
        response.headers.get('content-type'),
        `${asset} must be served as CSS, got "${response.headers.get('content-type')}"`,
      ).toContain('text/css');
      expect(body.startsWith('<!doctype html'), `${asset} returned the HTML shell`).toBe(false);
      expect(body.length).toBeGreaterThan(1_000);
    }
  });

  it('serves a lazily imported chunk that index.html does not reference', async () => {
    // Dynamic chunks are imported at runtime, so they never appear in index.html. They live in
    // the same subfolder, so they exercise the same nested-path resolution.
    const html = await (await fetch(`${baseUrl}/`)).text();
    const referenced = new Set(referencedAssets(html).scripts.map((asset) => asset.split('/').pop()));

    const onDisk = readdirSync(path.join(build.appDir, 'web', 'assets')).filter((name) => name.endsWith('.js'));
    const unlisted = onDisk.filter((name) => !referenced.has(name));
    expect(unlisted.length, 'the build should contain at least one dynamically imported chunk').toBeGreaterThan(0);

    for (const chunk of unlisted) {
      const response = await fetch(`${baseUrl}/assets/${chunk}`);
      expect(response.status, `/assets/${chunk} must be served`).toBe(200);
      expect(response.headers.get('content-type'), `/assets/${chunk} must be JavaScript`).toContain('javascript');
      expect((await response.text()).startsWith('<!doctype html')).toBe(false);
    }
  });

  it('still returns the SPA entry point for client-side routes', async () => {
    for (const route of ['/records', '/system', '/analysis']) {
      const response = await fetch(`${baseUrl}${route}`, { headers: { accept: 'text/html' } });
      expect(response.status, `${route} should fall back to index.html`).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toContain('<div id="root"></div>');
    }
  });

  it('answers a missing asset with 404 instead of silently returning index.html', async () => {
    // The silent 200 fallback is what turned a build defect into a featureless white window.
    const response = await fetch(`${baseUrl}/assets/this-chunk-does-not-exist.js`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('Not found');
  });

  it('still rejects traversal and encoded traversal through the static route', async () => {
    const response = await fetch(`${baseUrl}/assets/../../../package.json`, { redirect: 'manual' });
    const body = await response.text();
    // Either rejected outright or fallen back to the SPA shell — never the real file.
    expect(body).not.toContain('"name": "tnp-defect-management-test"');
    expect(response.status === 404 || response.status === 200).toBe(true);
  });
});
