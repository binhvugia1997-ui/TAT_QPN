import { spawnSync } from 'node:child_process';
import {
  createRequire,
  isBuiltin,
} from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression test for the Windows UAT failure:
 *
 *   Uncaught Exception:
 *   Error: Cannot find module '../../server/startupSignals'
 *   Require stack: dist-desktop/desktop/main/serverProcess.js
 *
 * tsc emits the desktop program with its source directory shape, so
 * `desktop/main/serverProcess.js` requires `../../server/startupSignals` and expects
 * `dist-desktop/server/` to sit beside `dist-desktop/desktop/`. The packager used to copy only
 * the `desktop` subtree, silently dropping that sibling, and the packaged app died on launch.
 *
 * A "does the file exist" check cannot catch this: the entry file was present and only the
 * *resolution* failed. So this test assembles the real portable build against a stand-in
 * Electron runtime, then
 *   (a) walks the packaged require graph and resolves every specifier exactly as Node would, and
 *   (b) actually `require()`s the packaged module from the Windows stack trace.
 *
 * The Electron runtime is the only thing stubbed. Everything under test — the compiler output
 * layout, the assembler's copy step and Node's module resolution — is the real thing.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(path.join(repoRoot, 'noop.js'));
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};

const ELECTRON_VERSION = (pkg.devDependencies.electron ?? '').replace(/^[\^~]/u, '');
const RUNTIME_DIR_NAME = `electron-v${ELECTRON_VERSION}-win32-x64`;
const CACHE_DIR = path.join(repoRoot, '.cache');
const STUB_DIR = path.join(CACHE_DIR, RUNTIME_DIR_NAME);

/** Bare specifiers the packaged desktop is allowed to require without a node_modules folder. */
const RUNTIME_PROVIDED = new Set(['electron']);

let outDir = '';
let createdStub = false;
const buildsRun: string[] = [];

function run(script: string): void {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', script], { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`\`npm run ${script}\` failed:\n${result.stderr ?? result.stdout ?? ''}`);
  }
  buildsRun.push(script);
}

function ensureBuilds(): void {
  if (!existsSync(path.join(repoRoot, 'dist', 'index.html'))) run('build');
  if (!existsSync(path.join(repoRoot, 'dist-server', 'server', 'index.js'))) run('build:server');
  if (!existsSync(path.join(repoRoot, 'dist-desktop', 'desktop', 'main', 'main.js'))) run('build:desktop');
}

/** A stand-in Electron runtime: enough of a tree for the assembler, no network needed. */
function ensureStubRuntime(): void {
  if (existsSync(path.join(STUB_DIR, 'electron.exe')) || existsSync(path.join(STUB_DIR, 'TNP Defect Management TEST.exe'))) {
    return;
  }
  mkdirSync(path.join(STUB_DIR, 'resources'), { recursive: true });
  writeFileSync(path.join(STUB_DIR, 'electron.exe'), 'stub-runtime');
  writeFileSync(path.join(STUB_DIR, 'electron.dll'), 'stub');
  writeFileSync(path.join(STUB_DIR, 'resources', 'default_app.asar'), '{}');
  createdStub = true;
}

beforeAll(() => {
  ensureBuilds();
  ensureStubRuntime();

  outDir = path.join(tmpdir(), `tnp-portable-runtime-${process.pid}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'package-portable.mjs'), `--out=${outDir}`], {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`The portable assembler failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
}, 300_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
  if (!createdStub) return;
  rmSync(STUB_DIR, { recursive: true, force: true });
  // Leave no empty .cache behind, but never touch a cache that holds a real runtime.
  try {
    if (existsSync(CACHE_DIR) && readdirSync(CACHE_DIR).length === 0) rmSync(CACHE_DIR, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort.
  }
});

function appDir(): string {
  const folders = readdirSync(outDir);
  expect(folders.length).toBeGreaterThan(0);
  return path.join(outDir, folders[0] as string, 'resources', 'app');
}

/** Resolves a relative specifier the way Node's CJS loader does, or returns null. */
function resolveAsNode(specifier: string, fromFile: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.json`, `${base}.node`];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  // Directory: package.json "main", then index.js.
  if (existsSync(base) && statSync(base).isDirectory()) {
    const manifestPath = path.join(base, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { main?: string };
        if (manifest.main) {
          const resolved = resolveAsNode(`./${manifest.main.replace(/^\.\\//u, '')}`, path.join(base, 'noop.js'));
          if (resolved) return resolved;
        }
      } catch {
        // Fall through to index.js.
      }
    }
    const index = path.join(base, 'index.js');
    if (existsSync(index)) return index;
  }
  return null;
}

/**
 * `module.isBuiltin` rather than the `builtinModules` list: the latter omits experimental
 * builtins such as `node:sqlite`, which this server genuinely depends on.
 */
function isNodeBuiltin(specifier: string): boolean {
  return isBuiltin(specifier);
}

interface MissingRequire {
  from: string;
  specifier: string;
}

/**
 * Walks every `require()` in the packaged desktop output and resolves it. Relative specifiers
 * must resolve inside the package; bare ones must be Node builtins or provided by Electron.
 */
function walkRequireGraph(entry: string): { visited: string[]; missing: MissingRequire[]; bare: string[] } {
  const visited: string[] = [];
  const missing: MissingRequire[] = [];
  const bare = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.includes(file)) continue;
    visited.push(file);

    const source = readFileSync(file, 'utf8');
    const pattern = /require\(\s*["']([^"']+)["']\s*\)/gu;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1] as string;

      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const resolved = resolveAsNode(specifier, file);
        if (!resolved) {
          missing.push({ from: path.relative(appDir(), file), specifier });
          continue;
        }
        if (resolved.endsWith('.js')) queue.push(resolved);
        continue;
      }

      bare.add(specifier);
      if (!isNodeBuiltin(specifier) && !RUNTIME_PROVIDED.has(specifier)) {
        missing.push({ from: path.relative(appDir(), file), specifier });
      }
    }
  }

  return { visited, missing, bare: [...bare] };
}

describe('packaged portable desktop runtime', () => {
  it('assembles a portable folder with the documented entry point', () => {
    const app = appDir();
    const manifest = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8')) as { main: string };

    expect(manifest.main).toBe('dist/desktop/main/main.js');
    const entry = path.join(app, manifest.main);
    expect(existsSync(entry), `the declared Electron entry ${manifest.main} must exist`).toBe(true);
  });

  it('ships the sibling module the desktop main process requires', () => {
    const app = appDir();
    // This is the exact file the Windows build was missing.
    expect(existsSync(path.join(app, 'dist', 'server', 'startupSignals.js'))).toBe(true);
    expect(existsSync(path.join(app, 'dist', 'desktop', 'main', 'serverProcess.js'))).toBe(true);
    expect(existsSync(path.join(app, 'dist', 'desktop', 'preload', 'preload.js'))).toBe(true);
  });

  it('resolves every require in the packaged desktop chain the way Node does', () => {
    const app = appDir();
    const entry = path.join(app, 'dist', 'desktop', 'main', 'main.js');
    const { visited, missing, bare } = walkRequireGraph(entry);

    // The walk must actually reach the module that failed on Windows.
    expect(visited.some((file) => file.endsWith(path.join('desktop', 'main', 'serverProcess.js')))).toBe(true);
    expect(visited.some((file) => file.endsWith(path.join('server', 'startupSignals.js')))).toBe(true);
    expect(visited.length).toBeGreaterThanOrEqual(7);

    // The only bare dependency allowed is Electron itself (plus Node builtins).
    expect(bare.filter((specifier) => !isNodeBuiltin(specifier))).toEqual(['electron']);

    expect(missing, `unresolvable requires in the packaged desktop:\n${JSON.stringify(missing, null, 2)}`).toEqual([]);
  });

  it('loads the packaged serverProcess module, which pulls in startupSignals', () => {
    const app = appDir();
    const serverProcessPath = path.join(app, 'dist', 'desktop', 'main', 'serverProcess.js');

    // The Windows crash was thrown from exactly this require chain, so execute it for real.
    // It has no Electron dependency, so it must load anywhere.
    let loaded: typeof import('../../desktop/main/serverProcess');
    expect(() => {
      loaded = require_(serverProcessPath) as typeof import('../../desktop/main/serverProcess');
    }, `requiring the packaged serverProcess.js must not throw`).not.toThrow();

    expect(typeof loaded!.startOwnedServer).toBe('function');
    expect(typeof loaded!.findFreePort).toBe('function');
    expect(typeof loaded!.ServerStartError).toBe('function');
  });

  it('loads the packaged startupSignals module and its handshake helpers work', () => {
    const app = appDir();
    const signals = require_(path.join(app, 'dist', 'server', 'startupSignals.js')) as
      typeof import('../../server/startupSignals');

    expect(typeof signals.parseStartupSignal).toBe('function');
    expect(typeof signals.classifyStartupError).toBe('function');

    // The handshake is what lets the desktop learn the real port, so prove it round-trips
    // from the packaged copy rather than from the source tree.
    let line = '';
    signals.writeReadyLine(
      {
        port: 8787,
        bindHost: '127.0.0.1',
        lanEnabled: false,
        databaseFile: 'tnp.db',
        schemaVersion: 1,
        records: 191,
        seeded: 191,
        alreadyInitialized: false,
      },
      (text) => { line = text; },
    );
    expect(signals.parseStartupSignal(line)).toMatchObject({ marker: 'ready', payload: { port: 8787 } });
    expect(signals.classifyStartupError(new Error('listen EADDRINUSE'))).toBe('port');
  });

  it('resolves the packaged preload and the server runtime entry', () => {
    const app = appDir();

    const preloadGraph = walkRequireGraph(path.join(app, 'dist', 'desktop', 'preload', 'preload.js'));
    expect(preloadGraph.missing).toEqual([]);
    expect(preloadGraph.bare.filter((specifier) => !isNodeBuiltin(specifier))).toEqual(['electron']);

    const serverEntry = path.join(app, 'server-runtime', 'server', 'index.js');
    expect(existsSync(serverEntry)).toBe(true);
    // The server runtime keeps its own CommonJS scope marker.
    const scope = JSON.parse(readFileSync(path.join(app, 'server-runtime', 'package.json'), 'utf8')) as { type?: string };
    expect(scope.type).toBe('commonjs');
  });

  it('ships the complete server runtime, not just its entry file', () => {
    const app = appDir();
    const serverRuntime = path.join(app, 'server-runtime');

    const entryGraph = walkRequireGraph(path.join(serverRuntime, 'server', 'index.js'));
    expect(
      entryGraph.missing,
      `unresolvable requires in the packaged server runtime:\n${JSON.stringify(entryGraph.missing, null, 2)}`,
    ).toEqual([]);

    // A partial copy would leave the server unable to start, so assert real depth.
    expect(entryGraph.visited.length).toBeGreaterThan(15);
    expect(existsSync(path.join(serverRuntime, 'server', 'http', 'app.js'))).toBe(true);
    expect(existsSync(path.join(serverRuntime, 'server', 'db', 'connection.js'))).toBe(true);
  });
});
