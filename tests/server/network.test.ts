import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PORT, LAN_BIND, LOCALHOST_BIND, loadServerConfig, saveServerConfig } from '../../server/config';
import { getLanAddresses } from '../../server/lan';
import { acquireDatabaseLock, DatabaseLockError } from '../../server/lock';
import { resolveRuntimePaths } from '../../server/paths';
import { api, startTestServer } from './helpers';
import type { TestEnvironment } from './helpers';

let environment: TestEnvironment | undefined;
const scratchDirs: string[] = [];

afterEach(async () => {
  await environment?.close();
  environment = undefined;
  for (const directory of scratchDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'tnp-lan-'));
  scratchDirs.push(directory);
  return directory;
}

describe('localhost is the default', () => {
  it('binds 127.0.0.1 and reports LAN disabled with no configuration', () => {
    const paths = resolveRuntimePaths({ root: tempRoot(), env: {} });
    const config = loadServerConfig(paths, {});

    expect(config.lanEnabled).toBe(false);
    expect(config.bindHost).toBe(LOCALHOST_BIND);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.sources.lan).toBe('default');
  });

  it('never defaults to 0.0.0.0', () => {
    const paths = resolveRuntimePaths({ root: tempRoot(), env: {} });
    expect(loadServerConfig(paths, {}).bindHost).not.toBe(LAN_BIND);
    expect(loadServerConfig(paths, { TNP_LAN: '0' }).bindHost).toBe(LOCALHOST_BIND);
    expect(loadServerConfig(paths, { TNP_LAN: 'false' }).bindHost).toBe(LOCALHOST_BIND);
    expect(loadServerConfig(paths, { TNP_LAN: 'off' }).bindHost).toBe(LOCALHOST_BIND);
  });

  it('reports the actual bind address and port through the status endpoint', async () => {
    environment = await startTestServer();
    const { body } = await api<{
      server: { bindAddress: string; actualPort: number; lanEnabled: boolean; lanAddresses: unknown[]; localhostUrl: string };
    }>(environment.baseUrl, 'GET', '/api/status');

    const address = environment.server.address() as AddressInfo;
    expect(body.server.bindAddress).toBe(address.address);
    expect(body.server.actualPort).toBe(address.port);
    expect(body.server.lanEnabled).toBe(false);
    expect(body.server.lanAddresses).toEqual([]);
    expect(body.server.localhostUrl).toBe(`http://127.0.0.1:${address.port}`);
  });

  it('warns that LAN mode has no authentication or TLS', async () => {
    environment = await startTestServer({ configOverrides: { lanEnabled: true } });
    const { body } = await api<{ security: { authentication: boolean; tls: boolean; warning: string } }>(
      environment.baseUrl,
      'GET',
      '/api/status',
    );

    expect(body.security.authentication).toBe(false);
    expect(body.security.tls).toBe(false);
    expect(body.security.warning).toMatch(/trusted internal network/iu);
    expect(body.security.warning).toMatch(/firewall/iu);
  });
});

describe('explicit LAN binding', () => {
  it('binds 0.0.0.0 only when LAN is explicitly enabled by argument', async () => {
    environment = await startTestServer({ configOverrides: { lanEnabled: true, bindHost: LAN_BIND } });
    const address = environment.server.address() as AddressInfo;
    expect(address.address).toBe(LAN_BIND);

    const { body } = await api<{ server: { lanEnabled: boolean } }>(environment.baseUrl, 'GET', '/api/status');
    expect(body.server.lanEnabled).toBe(true);
  });

  it('enables LAN through the TNP_LAN environment variable', () => {
    const paths = resolveRuntimePaths({ root: tempRoot(), env: {} });
    for (const flag of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(loadServerConfig(paths, { TNP_LAN: flag }).lanEnabled).toBe(true);
      expect(loadServerConfig(paths, { TNP_LAN: flag }).bindHost).toBe(LAN_BIND);
    }
  });

  it('enables LAN through the persisted config file', () => {
    const root = tempRoot();
    const paths = resolveRuntimePaths({ root, env: {} });
    expect(loadServerConfig(paths, {}).lanEnabled).toBe(false);

    saveServerConfig(paths, { lanEnabled: true, port: 9100 });
    const config = loadServerConfig(paths, {});

    expect(config.lanEnabled).toBe(true);
    expect(config.bindHost).toBe(LAN_BIND);
    expect(config.port).toBe(9100);
    expect(config.sources.lan).toBe('config-file');
  });

  it('lets the environment override the persisted config file', () => {
    const root = tempRoot();
    const paths = resolveRuntimePaths({ root, env: {} });
    saveServerConfig(paths, { lanEnabled: true });

    const config = loadServerConfig(paths, { TNP_LAN: '0' });
    expect(config.lanEnabled).toBe(false);
    expect(config.bindHost).toBe(LOCALHOST_BIND);
    expect(config.sources.lan).toBe('environment');
  });

  it('does not hardcode any owner IP address', () => {
    const paths = resolveRuntimePaths({ root: tempRoot(), env: {} });
    for (const config of [loadServerConfig(paths, {}), loadServerConfig(paths, { TNP_LAN: '1' })]) {
      expect(['127.0.0.1', '0.0.0.0']).toContain(config.bindHost);
      expect(config.bindHost).not.toMatch(/^192\.168\./u);
      expect(config.bindHost).not.toMatch(/^10\./u);
    }
  });

  it('detects usable LAN addresses, excluding loopback', () => {
    const addresses = getLanAddresses(8787);
    expect(Array.isArray(addresses)).toBe(true);
    for (const entry of addresses) {
      expect(entry.address).not.toBe('127.0.0.1');
      expect(entry.address.startsWith('fe80')).toBe(false);
      expect(entry.url).toMatch(/^http:\/\/.+:8787$/u);
    }
  });

  it('does not offer an endpoint that lets a client change LAN configuration', async () => {
    environment = await startTestServer({ configOverrides: { lanEnabled: true } });
    for (const route of ['/api/config', '/api/lan', '/api/server/config']) {
      expect((await api(environment.baseUrl, 'POST', route, { lanEnabled: false })).status).toBe(404);
      expect((await api(environment.baseUrl, 'PATCH', route, { lanEnabled: false })).status).toBe(404);
    }

    const status = await api<{ server: { lanEnabled: boolean } }>(environment.baseUrl, 'GET', '/api/status');
    expect(status.body.server.lanEnabled).toBe(true);
  });

  it('does not attempt to modify the firewall itself', async () => {
    environment = await startTestServer({ configOverrides: { lanEnabled: true } });
    const { body } = await api<{ security: { warning: string } }>(environment.baseUrl, 'GET', '/api/status');
    // The operator is told what to allow; the server never touches Windows Firewall.
    expect(body.security.warning).toMatch(/allow the app through the Windows Private-network firewall/iu);
  });
});

describe('single-owner database locking', () => {
  it('refuses a second server that targets the same data directory', () => {
    const root = tempRoot();
    const lockFile = path.join(root, 'data', 'tnp.lock');
    const databaseFile = path.join(root, 'data', 'tnp.db');

    const release = acquireDatabaseLock(lockFile, databaseFile);
    try {
      expect(() => acquireDatabaseLock(lockFile, databaseFile)).toThrow(DatabaseLockError);
      expect(() => acquireDatabaseLock(lockFile, databaseFile)).toThrow(/already owns/u);
    } finally {
      release();
    }

    // After a clean shutdown the lock is released and a new server may start.
    expect(() => acquireDatabaseLock(lockFile, databaseFile)).not.toThrow();
  });

  it('takes over a stale lock left behind by a dead process', () => {
    const root = tempRoot();
    const lockFile = path.join(root, 'data', 'tnp.lock');
    const databaseFile = path.join(root, 'data', 'tnp.db');

    mkdirSync(path.dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, JSON.stringify({
      pid: 999_999,
      hostname: hostname(),
      startedAt: new Date(0).toISOString(),
      databaseFile,
    }));

    const release = acquireDatabaseLock(lockFile, databaseFile);
    try {
      const current = JSON.parse(readFileSync(lockFile, 'utf8'));
      expect(current.pid).toBe(process.pid);
    } finally {
      release();
    }
  });
});
