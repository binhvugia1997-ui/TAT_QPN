import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as net from 'node:net';
import {
  classifyStartupError,
  parseStartupSignal,
  writeFatalLine,
  writeReadyLine,
} from '../../server/startupSignals';
import { ServerStartError, findFreePort, startOwnedServer } from '../../desktop/main/serverProcess';
import type { ChildLike, ServerProcessDeps } from '../../desktop/main/serverProcess';

/** A fake child process whose stdout/stderr we control. */
class FakeChild extends EventEmitter implements ChildLike {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitReady(payload: Record<string, unknown>): void {
    let line = '';
    writeReadyLine(payload as never, (text) => { line = text; });
    this.stdout.write(line);
  }

  emitFatal(reason: string, message: string): void {
    let line = '';
    writeFatalLine(reason as never, message, (text) => { line = text; });
    // The real server writes fatal lines to stderr.
    this.stderr.write(line);
  }
}

function depsFor(children: FakeChild[], healthStatus: number | null = 200): { deps: ServerProcessDeps; ports: number[] } {
  const ports: number[] = [];
  let index = 0;
  const deps: ServerProcessDeps = {
    spawn: () => {
      const child = children[index] ?? children[children.length - 1]!;
      index += 1;
      return child;
    },
    findFreePort: async (preferred) => {
      const port = preferred > 0 ? preferred : 49_000 + ports.length;
      ports.push(port);
      return port;
    },
    probeHealth: async () => healthStatus,
    // Real (but scaled) timers: the handshake races an event against a timeout, so the
    // timeout has to be able to actually elapse.
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, Math.min(ms, 10)); }),
    now: () => Date.now(),
  };
  return { deps, ports };
}

const baseInput = {
  nodeExecutable: '/usr/bin/node',
  serverEntry: '/app/server-runtime/server/index.js',
  env: { TNP_DATA_DIR: '/app/data' },
  preferredPort: 8787,
  lanEnabled: false,
  bindHost: '127.0.0.1',
  startupTimeoutMs: 2_000,
  healthTimeoutMs: 2_000,
};

describe('startup signal lines', () => {
  it('round-trips a ready line', () => {
    let line = '';
    writeReadyLine({
      port: 8787,
      bindHost: '127.0.0.1',
      lanEnabled: false,
      databaseFile: 'tnp.db',
      schemaVersion: 1,
      records: 191,
      seeded: 191,
      alreadyInitialized: false,
    }, (text) => { line = text; });

    const parsed = parseStartupSignal(line);
    expect(parsed?.marker).toBe('ready');
    expect(parsed?.payload).toMatchObject({ port: 8787, records: 191, lanEnabled: false });
  });

  it('round-trips a fatal line', () => {
    let line = '';
    writeFatalLine('lock', 'Another TNP server already owns the database.', (text) => { line = text; });
    const parsed = parseStartupSignal(line);
    expect(parsed?.marker).toBe('fatal');
    expect(parsed?.payload).toMatchObject({ reason: 'lock' });
  });

  it('ignores ordinary log output', () => {
    expect(parseStartupSignal('  Storage      SQLite at tnp.db')).toBeNull();
    expect(parseStartupSignal('TNP_READY')).toBeNull();
    expect(parseStartupSignal('TNP_READY not-json')).toBeNull();
  });

  it('classifies failures so the desktop can react correctly', () => {
    expect(classifyStartupError(new Error('listen EADDRINUSE: address already in use'))).toBe('port');
    expect(classifyStartupError(new Error('Another TNP server (pid 12) already owns "/data/tnp.db".'))).toBe('lock');
    expect(classifyStartupError(new Error('The canonical seed file is missing'))).toBe('seed');
    expect(classifyStartupError(new Error('SQLITE_CORRUPT: database disk image is malformed'))).toBe('database');
    expect(classifyStartupError(new Error('something else entirely'))).toBe('unknown');
  });
});

describe('desktop server startup', () => {
  it('waits for the ready line and the health endpoint before resolving', async () => {
    const child = new FakeChild();
    const { deps, ports } = depsFor([child]);
    const promise = startOwnedServer(baseInput, deps);
    child.emitReady({ port: 8787, bindHost: '127.0.0.1', lanEnabled: false });

    const owned = await promise;
    expect(owned.port).toBe(8787);
    expect(owned.baseUrl).toBe('http://127.0.0.1:8787');
    expect(owned.lanEnabled).toBe(false);
    expect(owned.pid).toBe(4242);
    expect(ports).toEqual([8787]);
  });

  it('reports the actual bound port when it differs from the requested one', async () => {
    const child = new FakeChild();
    const { deps } = depsFor([child]);
    const promise = startOwnedServer(baseInput, deps);
    child.emitReady({ port: 51234, bindHost: '127.0.0.1', lanEnabled: false });

    expect((await promise).baseUrl).toBe('http://127.0.0.1:51234');
  });

  it('surfaces a database lock instead of showing a dead window', async () => {
    const child = new FakeChild();
    const { deps } = depsFor([child]);
    const promise = startOwnedServer(baseInput, deps);
    child.emitFatal('lock', 'Another TNP server (pid 900) already owns "/data/tnp.db".');

    await expect(promise).rejects.toMatchObject({
      name: 'ServerStartError',
      reason: 'lock',
      message: 'Another TNP server (pid 900) already owns "/data/tnp.db".',
    });
    // A lock will not heal by retrying, so only one attempt is made.
    expect(child.killed).toBe(false);
  });

  it('retries on a free port when the preferred one is taken', async () => {
    const busy = new FakeChild();
    const ok = new FakeChild();
    const { deps, ports } = depsFor([busy, ok]);
    const promise = startOwnedServer(baseInput, deps);

    busy.emitFatal('port', 'listen EADDRINUSE: address already in use 127.0.0.1:8787');
    ok.emitReady({ port: 49_000, bindHost: '127.0.0.1', lanEnabled: false });

    const owned = await promise;
    expect(owned.port).toBe(49_000);
    // The desktop must never attach to whatever already holds the preferred port.
    expect(ports).toHaveLength(2);
    expect(ports[0]).toBe(8787);
    expect(ports[1]).not.toBe(8787);
  });

  it('fails when the server never answers the health endpoint', async () => {
    const child = new FakeChild();
    const { deps } = depsFor([child], null);
    const promise = startOwnedServer({ ...baseInput, healthTimeoutMs: 300 }, deps);
    child.emitReady({ port: 8787, bindHost: '127.0.0.1', lanEnabled: false });

    await expect(promise).rejects.toBeInstanceOf(ServerStartError);
    expect(child.killed).toBe(true);
  });

  it('passes the LAN flag and the resolved port to the child', async () => {
    const child = new FakeChild();
    const seen: string[][] = [];
    const { deps } = depsFor([child]);
    const wrapped: ServerProcessDeps = {
      ...deps,
      spawn: (command, args) => {
        seen.push([command, ...args]);
        return child;
      },
    };
    const promise = startOwnedServer({ ...baseInput, lanEnabled: true, bindHost: '0.0.0.0' }, wrapped);
    child.emitReady({ port: 8787, bindHost: '0.0.0.0', lanEnabled: true });

    await promise;
    expect(seen[0]).toEqual([
      '/usr/bin/node',
      '/app/server-runtime/server/index.js',
      '--port', '8787',
      '--lan',
      '--host', '0.0.0.0',
    ]);
  });
});

describe('port discovery', () => {
  it('returns the preferred port when nothing else holds it', async () => {
    const free = await findFreePortFree();
    expect(await findFreePort(free, '127.0.0.1')).toBe(free);
  });

  it('falls back to another port when the preferred one is busy', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const busyPort = (holder.address() as net.AddressInfo).port;
    try {
      const chosen = await findFreePort(busyPort, '127.0.0.1');
      expect(chosen).not.toBe(busyPort);
      expect(chosen).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});

/** Asks the OS for a port and immediately releases it. */
async function findFreePortFree(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
