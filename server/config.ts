import fs from 'node:fs';
import path from 'node:path';
import type { RuntimePaths } from './paths';

export const DEFAULT_PORT = 8787;
export const LOCALHOST_BIND = '127.0.0.1';
export const LAN_BIND = '0.0.0.0';

export interface ServerConfig {
  port: number;
  lanEnabled: boolean;
  bindHost: string;
  /** Where each setting came from, for the status endpoint and startup log. */
  sources: { port: string; lan: string };
}

export interface PersistedConfig {
  lanEnabled?: boolean;
  port?: number;
}

function readConfigFile(configFile: string): PersistedConfig {
  try {
    if (!fs.existsSync(configFile)) return {};
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const candidate = parsed as Record<string, unknown>;
    const result: PersistedConfig = {};
    if (typeof candidate.lanEnabled === 'boolean') result.lanEnabled = candidate.lanEnabled;
    if (typeof candidate.port === 'number' && Number.isInteger(candidate.port)) result.port = candidate.port;
    return result;
  } catch {
    // A malformed config file must not prevent startup; defaults apply instead.
    return {};
  }
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

export interface ConfigOverrides {
  port?: number;
  lanEnabled?: boolean;
  bindHost?: string;
}

/**
 * LAN exposure is never implicit. Environment variables win over the persisted
 * `data/server.json`, which wins over the localhost-only default.
 */
export function loadServerConfig(
  paths: RuntimePaths,
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
): ServerConfig {
  const file = readConfigFile(paths.configFile);

  const envPort = env.TNP_PORT ? Number(env.TNP_PORT) : undefined;
  const port = overrides.port
    ?? (envPort && Number.isInteger(envPort) && envPort > 0 ? envPort : undefined)
    ?? file.port
    ?? DEFAULT_PORT;

  const envLan = parseBooleanFlag(env.TNP_LAN ?? env.TNP_ALLOW_LAN);
  const lanEnabled = overrides.lanEnabled ?? envLan ?? file.lanEnabled ?? false;

  const bindHost = overrides.bindHost
    ?? env.TNP_HOST
    ?? (lanEnabled ? LAN_BIND : LOCALHOST_BIND);

  return {
    port,
    lanEnabled,
    bindHost,
    sources: {
      port: overrides.port ? 'argument' : envPort ? 'environment' : file.port ? 'config-file' : 'default',
      lan: overrides.lanEnabled !== undefined ? 'argument'
        : envLan !== undefined ? 'environment'
          : file.lanEnabled !== undefined ? 'config-file'
            : 'default',
    },
  };
}

export function saveServerConfig(paths: RuntimePaths, patch: PersistedConfig): PersistedConfig {
  const current = readConfigFile(paths.configFile);
  const next: PersistedConfig = { ...current, ...patch };
  fs.mkdirSync(path.dirname(paths.configFile), { recursive: true });
  fs.writeFileSync(paths.configFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
