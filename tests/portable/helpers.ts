import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared setup for tests that exercise the **assembled** portable build rather than the source
 * tree. A stand-in Electron runtime is the only thing faked; the compiler output, the assembler
 * and the packaged server are all real.
 */

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
};

export const ELECTRON_VERSION = (pkg.devDependencies.electron ?? '').replace(/^[\^~]/u, '');
const RUNTIME_DIR_NAME = `electron-v${ELECTRON_VERSION}-win32-x64`;
const CACHE_DIR = path.join(repoRoot, '.cache');
const STUB_DIR = path.join(CACHE_DIR, RUNTIME_DIR_NAME);

export interface AssembledBuild {
  /** resources/app inside the assembled portable folder. */
  appDir: string;
  /** The portable folder itself. */
  targetDir: string;
  cleanup: () => void;
}

function runBuild(script: string): void {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', script], { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`\`npm run ${script}\` failed:\n${result.stderr ?? result.stdout ?? ''}`);
  }
}

/**
 * Always rebuilds. Skipping a build when its output already exists lets these tests pass
 * against stale artifacts — a reintroduced source bug would then go unnoticed, which is the
 * one thing a regression test must never do.
 */
export function ensureBuilds(): void {
  runBuild('build');
  runBuild('build:server');
  runBuild('build:desktop');
}

/** A stand-in Electron runtime: enough of a tree for the assembler, no network needed. */
function ensureStubRuntime(): boolean {
  if (
    existsSync(path.join(STUB_DIR, 'electron.exe'))
    || existsSync(path.join(STUB_DIR, 'TNP Defect Management TEST.exe'))
  ) {
    return false;
  }
  mkdirSync(path.join(STUB_DIR, 'resources'), { recursive: true });
  writeFileSync(path.join(STUB_DIR, 'electron.exe'), 'stub-runtime');
  writeFileSync(path.join(STUB_DIR, 'electron.dll'), 'stub');
  writeFileSync(path.join(STUB_DIR, 'resources', 'default_app.asar'), '{}');
  return true;
}

/** Runs the real assembler into a throwaway directory and returns the packaged app folder. */
export function assemblePortableBuild(label: string): AssembledBuild {
  ensureBuilds();
  const createdStub = ensureStubRuntime();

  const outDir = path.join(tmpdir(), `tnp-portable-${label}-${process.pid}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'package-portable.mjs'), `--out=${outDir}`],
    { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`The portable assembler failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }

  const folders = readdirSync(outDir);
  if (folders.length === 0) throw new Error('The assembler produced no output folder.');
  const targetDir = path.join(outDir, folders[0] as string);
  const appDir = path.join(targetDir, 'resources', 'app');

  return {
    appDir,
    targetDir,
    cleanup: () => {
      rmSync(outDir, { recursive: true, force: true });
      if (!createdStub) return;
      rmSync(STUB_DIR, { recursive: true, force: true });
      try {
        if (existsSync(CACHE_DIR) && readdirSync(CACHE_DIR).length === 0) {
          rmSync(CACHE_DIR, { recursive: true, force: true });
        }
      } catch {
        // Cleanup is best effort.
      }
    },
  };
}

export function assertIsFile(file: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`Expected a file at ${file}`);
  }
}
