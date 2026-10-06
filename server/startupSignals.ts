/**
 * Machine-readable startup handshake.
 *
 * The desktop wrapper spawns this server as a child process and must learn the port it
 * actually bound to (it may differ from the requested one) and *why* startup failed if it
 * did. Parsing the human banner is fragile, so the server emits one JSON line per outcome
 * on stdout:
 *
 *   TNP_READY {"port":8787,"bindHost":"127.0.0.1",...}
 *   TNP_FATAL {"reason":"lock","message":"..."}
 *
 * A plain terminal run ignores these lines; they are additive and carry no new information
 * beyond what the banner already prints.
 */
export const READY_MARKER = 'TNP_READY';
export const FATAL_MARKER = 'TNP_FATAL';

export type StartupFailureReason =
  | 'lock'
  | 'port'
  | 'database'
  | 'seed'
  | 'config'
  | 'unknown';

export interface ReadySignal {
  port: number;
  bindHost: string;
  lanEnabled: boolean;
  databaseFile: string;
  schemaVersion: number;
  records: number;
  seeded: number;
  alreadyInitialized: boolean;
}

export interface FatalSignal {
  reason: StartupFailureReason;
  message: string;
}

export function writeReadyLine(payload: ReadySignal, write: (text: string) => void = defaultWrite): void {
  write(`${READY_MARKER} ${safeJson(payload)}\n`);
}

export function writeFatalLine(reason: StartupFailureReason, message: string, write: (text: string) => void = defaultWrite): void {
  write(`${FATAL_MARKER} ${safeJson({ reason, message } satisfies FatalSignal)}\n`);
}

/** Parses a signal line, or returns null when the line is not one. */
export function parseStartupSignal(line: string): { marker: 'ready' | 'fatal'; payload: Record<string, unknown> } | null {
  const trimmed = line.trim();
  let marker: 'ready' | 'fatal';
  if (trimmed.startsWith(READY_MARKER)) marker = 'ready';
  else if (trimmed.startsWith(FATAL_MARKER)) marker = 'fatal';
  else return null;

  const payload = trimmed.slice(trimmed.indexOf(' ') + 1).trim();
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return { marker, payload: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** `EADDRINUSE` in particular: the desktop can then retry on a free port. */
export function classifyStartupError(error: unknown): StartupFailureReason {
  const text = error instanceof Error ? `${error.message} ${error.stack ?? ''}` : String(error);
  if (/EADDRINUSE/iu.test(text)) return 'port';
  if (/already owns|database lock|SQLITE_BUSY/iu.test(text)) return 'lock';
  if (/seed|legacy-base-data|canonical/iu.test(text)) return 'seed';
  if (/SQLITE_|sqlite|schema|migration/iu.test(text)) return 'database';
  return 'unknown';
}

function defaultWrite(text: string): void {
  process.stdout.write(text);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ reason: 'unknown', message: 'unserializable startup payload' });
  }
}
