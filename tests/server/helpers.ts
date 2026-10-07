import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { closeContext, createContext } from '../../server/context';
import type { AppContext } from '../../server/context';
import { createHttpServer } from '../../server/http/app';
import { resolveRuntimePaths } from '../../server/paths';
import type { RuntimePaths } from '../../server/paths';
import type { ConfigOverrides } from '../../server/config';

export interface TestEnvironment {
  context: AppContext;
  server: http.Server;
  baseUrl: string;
  paths: RuntimePaths;
  root: string;
  close: (options?: { keepFiles?: boolean }) => Promise<void>;
}

export interface TestServerOptions {
  configOverrides?: ConfigOverrides;
  runDailyBackup?: boolean;
  env?: Record<string, string>;
  /** Serve no static bundle so API responses stay easy to assert on. */
  staticDir?: string | null;
}

/** Boots a real server against an isolated temporary data directory. */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestEnvironment> {
  const root = mkdtempSync(path.join(tmpdir(), 'tnp-phase5-'));
  const paths = resolveRuntimePaths({
    env: {
      TNP_DATA_DIR: path.join(root, 'data'),
      TNP_BACKUPS_DIR: path.join(root, 'backups'),
      TNP_REPORTS_DIR: path.join(root, 'reports'),
      TNP_DB_FILE: path.join(root, 'data', 'tnp.db'),
      TNP_LOCK_FILE: path.join(root, 'data', 'tnp.lock'),
      TNP_CONFIG_FILE: path.join(root, 'data', 'server.json'),
      ...options.env,
    },
  });

  const context = await createContext({
    paths,
    env: { ...process.env, ...options.env },
    configOverrides: options.configOverrides,
    runDailyBackup: options.runDailyBackup,
  });

  const server = createHttpServer({
    context,
    staticDir: options.staticDir === undefined ? null : options.staticDir,
  });

  await new Promise<void>((resolve) => server.listen(0, context.config.bindHost, resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    context,
    server,
    baseUrl,
    paths,
    root,
    close: async (options = {}) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeContext(context);
      // Tests that reopen the database file afterwards keep the temporary tree.
      if (!options.keepFiles) rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface ApiResponse<T> {
  status: number;
  body: T;
}

export async function api<T = unknown>(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed as T };
}

export function seedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mgmtNo: 'TEST-0001',
    registeredDate: '2026-07-01',
    status: 'Đợi đối sách',
    plant: 'SIEL',
    partCode: 'PART-1',
    title: 'Test defect',
    defectQty: 2,
    ...overrides,
  };
}
