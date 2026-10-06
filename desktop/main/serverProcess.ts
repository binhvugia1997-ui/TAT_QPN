/**
 * Owns the child `node` process that runs the Phase 5 server.
 *
 * The desktop never embeds SQLite and never talks to the database file directly: it starts
 * the same server the browser build uses, waits for its machine-readable `TNP_READY` line
 * to learn the real port, confirms it answers `GET /api/status`, and then points the window
 * at `http://127.0.0.1:<port>`. Everything is loopback unless the owner explicitly enabled
 * LAN.
 *
 * Two hazards are handled explicitly:
 *  - **Port collision.** If something else already holds the preferred port the desktop does
 *    *not* attach to that stranger; it picks a free port and retries.
 *  - **Database lock.** If another TNP server owns the data folder the child exits with
 *    `TNP_FATAL {"reason":"lock"}` and the desktop surfaces that message instead of showing
 *    a blank window.
 */
import { spawn as spawnChild } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import type { Readable } from 'node:stream';
import { classifyStartupError, parseStartupSignal } from '../../server/startupSignals';
import type { StartupFailureReason } from '../../server/startupSignals';

export interface ChildLike extends EventEmitter {
  pid?: number;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  readonly exitCode: number | null;
}

export interface ServerProcessDeps {
  spawn(command: string, args: readonly string[], options: Record<string, unknown>): ChildLike;
  findFreePort(preferred: number, host: string): Promise<number>;
  probeHealth(url: string): Promise<number | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface StartServerInput {
  nodeExecutable: string;
  serverEntry: string;
  env: Record<string, string>;
  preferredPort: number;
  lanEnabled: boolean;
  /** Loopback unless LAN was explicitly enabled by the owner. */
  bindHost: string;
  startupTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export interface OwnedServer {
  port: number;
  baseUrl: string;
  pid: number | undefined;
  bindHost: string;
  lanEnabled: boolean;
  stop(): Promise<void>;
  /** Resolves once the child exits, for any reason. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export class ServerStartError extends Error {
  constructor(
    public readonly reason: StartupFailureReason,
    message: string,
    public readonly diagnostics: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ServerStartError';
  }
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_MS = 150;
const MAX_PORT_ATTEMPTS = 3;
const STDERR_TAIL_LINES = 12;

export async function startOwnedServer(input: StartServerInput, deps: ServerProcessDeps): Promise<OwnedServer> {
  const startupTimeoutMs = input.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const healthTimeoutMs = input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;

  let lastError: ServerStartError | undefined;

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    // Re-probe on every retry: the port we checked a moment ago may already be gone.
    const port = await deps.findFreePort(attempt === 0 ? input.preferredPort : 0, input.bindHost === '0.0.0.0' ? '127.0.0.1' : input.bindHost);
    try {
      return await launch(input, deps, port, startupTimeoutMs, healthTimeoutMs);
    } catch (error) {
      if (!(error instanceof ServerStartError)) throw error;
      // Only a port problem is worth retrying; a lock or bad database will not heal.
      if (error.reason !== 'port') throw error;
      lastError = error;
    }
  }

  throw lastError ?? new ServerStartError('port', 'Could not find a free port for the TNP server.');
}

async function launch(
  input: StartServerInput,
  deps: ServerProcessDeps,
  port: number,
  startupTimeoutMs: number,
  healthTimeoutMs: number,
): Promise<OwnedServer> {
  const args = [
    input.serverEntry,
    '--port', String(port),
    ...(input.lanEnabled ? ['--lan'] : ['--no-lan']),
    '--host', input.bindHost,
  ];

  const stderrTail: string[] = [];
  let readyPayload: Record<string, unknown> | undefined;
  let fatal: { reason: StartupFailureReason; message: string } | undefined;

  const child = deps.spawn(input.nodeExecutable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Reuses the Electron binary as a plain Node runtime, so no separate Node install is
    // required on the owner's PC.
    env: { ...input.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });

  // Resolves as soon as any terminal event happens, so the wait below never busy-spins
  // and never misses a line that arrives between polls.
  let announce: () => void = () => undefined;
  const terminal = new Promise<void>((resolve) => { announce = resolve; });

  const collectLine = (line: string) => {
    const signal = parseStartupSignal(line);
    if (!signal) return;
    if (signal.marker === 'ready') readyPayload = signal.payload;
    else {
      fatal = {
        reason: String(signal.payload.reason ?? 'unknown') as StartupFailureReason,
        message: String(signal.payload.message ?? 'The TNP server refused to start.'),
      };
    }
    announce();
  };

  // Both streams carry signals: the ready line goes to stdout, a refusal to stderr.
  pipeLines(child.stdout, collectLine);
  pipeLines(child.stderr, (line) => {
    stderrTail.push(line);
    if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    collectLine(line);
  });

  const exited = waitForExit(child);
  let settled = false;
  exited.then(() => { settled = true; announce(); }).catch(() => { settled = true; announce(); });

  const timedOut = (await Promise.race([
    terminal.then(() => false),
    deps.sleep(startupTimeoutMs).then(() => true),
  ])) && !readyPayload && !fatal;

  if (timedOut) {
    child.kill('SIGTERM');
    throw new ServerStartError('unknown', 'The TNP server did not become ready in time.', stderrTail);
  }

  if (fatal) {
    throw new ServerStartError(fatal.reason, fatal.message, stderrTail);
  }
  if (!readyPayload) {
    const outcome = settled ? await exited.catch(() => null) : null;
    const reason = classifyStartupError(new Error(stderrTail.join('\n')));
    throw new ServerStartError(
      reason,
      `The TNP server exited before it was ready${outcome ? ` (code ${outcome.code ?? 'null'})` : ''}.`,
      stderrTail,
    );
  }

  const actualPort = toPort(readyPayload.port) ?? port;
  const baseUrl = `http://127.0.0.1:${actualPort}`;

  const healthy = await waitForHealth(deps, `${baseUrl}/api/status`, healthTimeoutMs, () => settled);
  if (!healthy) {
    child.kill('SIGTERM');
    throw new ServerStartError('unknown', `The TNP server started but ${baseUrl}/api/status did not answer.`, stderrTail);
  }

  return {
    port: actualPort,
    baseUrl,
    pid: child.pid,
    bindHost: String(readyPayload.bindHost ?? input.bindHost),
    lanEnabled: readyPayload.lanEnabled === true,
    exited,
    stop: () => stopChild(child, deps),
  };
}

async function stopChild(child: ChildLike, deps: ServerProcessDeps): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = deps.now() + 5_000;
  while (child.exitCode === null && deps.now() < deadline) {
    await deps.sleep(100);
  }
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitForHealth(
  deps: ServerProcessDeps,
  url: string,
  timeoutMs: number,
  hasExited: () => boolean,
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    if (hasExited()) return false;
    const status = await deps.probeHealth(url);
    if (status === 200) return true;
    await deps.sleep(HEALTH_POLL_MS);
  }
  return false;
}

function waitForExit(child: ChildLike): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: null });
      return;
    }
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
  });
}

function pipeLines(stream: Readable | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onLine(line);
      newline = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer);
  });
}

function toPort(value: unknown): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/** Real dependency set: binds a throwaway socket to discover a usable port. */
export const realDeps: ServerProcessDeps = {
  spawn: (command, args, options) =>
    spawnChild(command, [...args], options as never) as unknown as ChildLike,
  findFreePort: (preferred, host) => findFreePort(preferred, host),
  probeHealth: (url) => probeHealth(url),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now: () => Date.now(),
};

/** Returns `preferred` when it is free, otherwise an OS-assigned ephemeral port. */
export async function findFreePort(preferred: number, host: string): Promise<number> {
  if (preferred > 0) {
    const bound = await tryBind(preferred, host);
    if (bound !== null) return preferred;
  }
  const ephemeral = await tryBind(0, host);
  if (ephemeral === null) throw new Error('No free port is available for the TNP server.');
  return ephemeral;
}

/** Binds and immediately releases a socket; resolves to the port the OS assigned. */
export function tryBind(port: number, host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let assigned: number | null = null;
    server.once('error', () => { server.close(); resolve(null); });
    server.once('listening', () => {
      const address = server.address();
      if (address && typeof address === 'object') assigned = address.port;
      server.close(() => resolve(assigned));
    });
    server.listen(port, host);
  });
}

/** Returns the HTTP status of the health endpoint, or null when it is not answering. */
export async function probeHealth(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(1_500) });
    return response.status;
  } catch {
    return null;
  }
}
