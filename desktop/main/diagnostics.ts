/**
 * Startup diagnostics for the TEST portable build.
 *
 * A blank Electron window tells the owner nothing and gives Windows UAT nothing to report.
 * So every stage of startup is written to a plain-text log beside the data, and if the UI
 * does not appear the window is replaced with a compact page naming the reason, the port and
 * the exact URL that failed — no DevTools required.
 *
 * This module is Electron-free so the page and log formatting are unit tested directly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type StartupStage =
  | 'layout'
  | 'server-spawn'
  | 'server-ready'
  | 'server-exited'
  | 'window-created'
  | 'load-started'
  | 'load-finished'
  | 'load-failed'
  | 'ui-mounted'
  | 'ui-blank'
  | 'renderer-console'
  | 'renderer-gone'
  | 'update';

export interface DiagnosticLog {
  write(stage: StartupStage, message: string): void;
  path: string;
  close(): void;
}

/** Appends timestamped lines; never throws, because logging must not break startup. */
export function openDiagnosticLog(file: string): DiagnosticLog {
  let closed = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // Unwritable log location: diagnostics degrade, startup continues.
  }
  return {
    path: file,
    write(stage, message) {
      if (closed) return;
      try {
        fs.appendFileSync(file, `${new Date().toISOString()} [${stage}] ${message}\n`, 'utf8');
      } catch {
        // Ignore write failures.
      }
    },
    close() {
      closed = true;
    },
  };
}

export interface StartupFailure {
  /** Short, owner-readable reason. */
  reason: string;
  /** What actually failed, including any error text. */
  detail?: string;
  /** Port the owned server bound to, when known. */
  port?: number | null;
  /** The URL the window tried to load. */
  url?: string;
  /** Where the diagnostic log lives. */
  logFile?: string;
  /** Where the data lives. */
  dataDir?: string;
}

const escapeHtml = (value: string): string => value
  .replace(/&/gu, '&amp;')
  .replace(/</gu, '&lt;')
  .replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;');

/**
 * A compact, self-contained failure page. Inline styles only, because the very thing that
 * may have failed is the app's stylesheet.
 */
export function buildStartupErrorPage(failure: StartupFailure): string {
  const rows: Array<[string, string]> = [
    ['Reason', failure.reason],
  ];
  if (failure.detail) rows.push(['Detail', failure.detail]);
  if (failure.port !== undefined && failure.port !== null) rows.push(['Port', String(failure.port)]);
  if (failure.url) rows.push(['Failed URL', failure.url]);
  if (failure.logFile) rows.push(['Diagnostic log', failure.logFile]);
  if (failure.dataDir) rows.push(['Data folder', failure.dataDir]);

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<title>TNP Defect Management — startup problem</title>',
    '<style>',
    'body{margin:0;padding:2.5rem;background:#17231e;color:#eaf2ee;',
    "font:14px/1.55 system-ui,'Segoe UI',sans-serif}",
    '.card{max-width:760px;margin:0 auto;background:#1f2f29;border:1px solid #355046;',
    'border-radius:10px;padding:1.5rem 1.75rem}',
    'h1{font-size:1.15rem;margin:0 0 .35rem}',
    'p.lead{margin:0 0 1.25rem;opacity:.8}',
    'dl{display:grid;grid-template-columns:9.5rem 1fr;gap:.45rem .9rem;margin:0}',
    'dt{opacity:.65;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;padding-top:.15rem}',
    'dd{margin:0;word-break:break-all}',
    'code{background:#142019;padding:.1rem .35rem;border-radius:4px;font-size:.85em}',
    '.hint{margin-top:1.35rem;padding-top:1rem;border-top:1px solid #355046;opacity:.75;font-size:.85rem}',
    '</style></head><body><div class="card">',
    '<h1>The TNP interface did not start</h1>',
    '<p class="lead">Your data is untouched. This page replaces a blank window so the cause can be reported.</p>',
    '<dl>',
    ...rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(value)}</code></dd>`),
    '</dl>',
    '<p class="hint">Close this window and reopen the app to try again. If it repeats, send the '
      + 'diagnostic log above together with <code>data/server.log</code>.</p>',
    '</div></body></html>',
  ].join('');
}

/** Renders the failure page without touching the network or the filesystem. */
export function toDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function startupErrorUrl(failure: StartupFailure): string {
  return toDataUrl(buildStartupErrorPage(failure));
}

/** Human-readable reason for an Electron `did-fail-load` code. */
export function describeLoadFailure(errorCode: number, errorDescription: string): string {
  const known: Record<number, string> = {
    [-2]: 'The request was aborted.',
    [-3]: 'The request was blocked.',
    [-6]: 'The connection was refused — the local server is not answering on that port.',
    [-7]: 'The connection timed out.',
    [-12]: 'The host name could not be resolved.',
    [-14]: 'The connection was closed unexpectedly.',
    [-21]: 'The network changed while loading.',
    [-102]: 'The connection was refused — the local server is not answering on that port.',
    [-105]: 'The host name could not be resolved.',
    [-118]: 'The connection timed out.',
    [-336]: 'A certificate error occurred.',
  };
  const mapped = known[errorCode];
  return [mapped ?? `Load failed with code ${errorCode}.`, errorDescription].filter(Boolean).join(' ');
}
