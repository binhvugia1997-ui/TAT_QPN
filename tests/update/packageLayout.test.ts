/**
 * §31 — the update contract against the REAL assembled portable build.
 *
 * The other Phase 7 suites use a hand-built fixture. This one uses the actual assembler output,
 * so a change to the packager, the tsconfig output tree or the web bundle cannot silently break
 * the update path. It also re-asserts the two regressions this product has already shipped:
 *
 *   • Phase 6 — `resources/app/dist/server/startupSignals.js` must exist next to the desktop
 *     code, or the packaged server child process cannot start.
 *   • Phase 7 — every asset the packaged `index.html` references must be present under
 *     `resources/app/web/assets/`, or the window renders blank.
 *
 * The Electron runtime itself is the only stand-in (the real binaries cannot be downloaded in
 * this sandbox); its three marker files are added so the identity check can run for real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assemblePortableBuild } from '../portable/helpers';
import type { AssembledBuild } from '../portable/helpers';
import { REQUIRED_PACKAGE_ENTRIES, TNP_LAUNCHER_NAME, checkPackageIdentity, inspectPackageEntries } from '../../desktop/update/packageInspect';
import { collectRuntimeForPackage, publishUpdate, readExistingManifest } from '../../desktop/update/publish';
import { extractZip, listZipEntries } from '../../desktop/update/archive';
import { createTempDir } from './helpers';

let build: AssembledBuild;
const tempDirs: string[] = [];

function scratch(label: string): string {
  const dir = createTempDir(label);
  tempDirs.push(dir);
  return dir;
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function listFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, relative));
    else out.push(relative);
  }
  return out;
}

beforeAll(() => {
  build = assemblePortableBuild('update');
  // Stand in for the three Electron runtime files the real download would provide, so the
  // identity check runs against a runtime that looks like the shipped one.
  for (const marker of ['ffmpeg.dll', 'libEGL.dll', 'v8_context_snapshot.bin']) {
    const file = path.join(build.targetDir, marker);
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'stub-electron-runtime');
  }
}, 240_000);

afterAll(() => {
  build?.cleanup();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

describe('the assembled portable build satisfies the update contract', () => {
  it('ships every file the updater requires', () => {
    const files = listFiles(build.targetDir);
    const inspection = inspectPackageEntries(files);
    expect(inspection.missing).toEqual([]);
    expect(inspection.ok).toBe(true);
    for (const required of REQUIRED_PACKAGE_ENTRIES) {
      expect(fs.existsSync(path.join(build.targetDir, required)), `missing ${required}`).toBe(true);
    }
  });

  it('names its launcher exactly as the updater expects', () => {
    expect(TNP_LAUNCHER_NAME).toBe('TNP Defect Management TEST.exe');
    expect(fs.existsSync(path.join(build.targetDir, TNP_LAUNCHER_NAME))).toBe(true);
  });

  it('carries the version and build number the updater orders on', () => {
    const packaged = JSON.parse(
      fs.readFileSync(path.join(build.appDir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(packaged.name).toBe('tnp-defect-management-test');
    expect(typeof packaged.version).toBe('string');
    expect(Number.isInteger(packaged.tnpBuild)).toBe(true);
    expect(Number(packaged.tnpBuild)).toBeGreaterThan(0);

    const repository = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string; tnpBuild: number };
    expect(packaged.version).toBe(repository.version);
    expect(packaged.tnpBuild).toBe(repository.tnpBuild);
  });

  it('identifies itself as a TNP win-x64 runtime', () => {
    const packaged = JSON.parse(fs.readFileSync(path.join(build.appDir, 'package.json'), 'utf8'));
    const identity = checkPackageIdentity(packaged, {
      hasLauncher: fs.existsSync(path.join(build.targetDir, TNP_LAUNCHER_NAME)),
      hasElectronMarkers: ['ffmpeg.dll', 'libEGL.dll', 'v8_context_snapshot.bin']
        .every((marker) => fs.existsSync(path.join(build.targetDir, marker))),
    });
    expect(identity.reasons).toEqual([]);
    expect(identity.ok).toBe(true);
    expect(identity.architecture).toBe('win-x64');
  });

  it('ships the standalone updater helper inside the runtime', () => {
    // The helper is spawned from the staged runtime, so it has to be part of the package.
    const helper = path.join(build.targetDir, 'resources', 'app', 'dist', 'desktop', 'update', 'helperMain.js');
    expect(fs.existsSync(helper)).toBe(true);
    const compiled = fs.readFileSync(helper, 'utf8');
    // The helper really carries the rollback path and the runtime-backup folder naming.
    expect(compiled).toContain('rollbackRuntime');
    expect(compiled).toContain('runtime-backup');
    expect(compiled).toContain('ELECTRON_RUN_AS_NODE');
  });
});

describe('the packaged runtime survives the Phase 6 and Phase 7 regressions', () => {
  it('keeps startupSignals next to the desktop code so the server child can start', () => {
    const signals = path.join(build.appDir, 'dist', 'server', 'startupSignals.js');
    expect(fs.existsSync(signals)).toBe(true);

    // This is the Phase 6 failure exactly: shipping only dist/desktop drops the sibling
    // dist/server tree, so this require resolves to nothing at launch. Resolve the real
    // require spec from the compiled file instead of trusting a hand-written path.
    const serverProcess = fs.readFileSync(
      path.join(build.appDir, 'dist', 'desktop', 'main', 'serverProcess.js'),
      'utf8',
    );
    const spec = /require\("([^"]*startupSignals[^"]*)"\)/u.exec(serverProcess)?.[1];
    expect(spec, 'serverProcess.js no longer requires startupSignals').toBeTruthy();
    const resolved = path.resolve(
      path.join(build.appDir, 'dist', 'desktop', 'main'),
      `${spec as string}.js`,
    );
    expect(fs.existsSync(resolved), `the packaged require "${spec}" resolves nowhere`).toBe(true);
    expect(resolved).toBe(signals);

    expect(fs.existsSync(path.join(build.appDir, 'server-runtime', 'server', 'index.js'))).toBe(true);
  });

  it('serves every asset the packaged index.html references', () => {
    const html = fs.readFileSync(path.join(build.appDir, 'web', 'index.html'), 'utf8');
    const referenced = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/gu)].map((match) => match[1] as string);
    expect(referenced.length).toBeGreaterThan(0);
    for (const asset of referenced) {
      expect(fs.existsSync(path.join(build.appDir, 'web', asset)), `missing web asset ${asset}`).toBe(true);
    }
  });

  it('keeps the lazy parser chunk on disk next to the entry bundle', () => {
    const assets = fs.readdirSync(path.join(build.appDir, 'web', 'assets'));
    expect(assets.some((entry) => entry.startsWith('index-') && entry.endsWith('.js'))).toBe(true);
    expect(assets.some((entry) => entry.startsWith('index-') && entry.endsWith('.css'))).toBe(true);
    expect(assets.some((entry) => entry.startsWith('tnpFileParser-') && entry.endsWith('.js'))).toBe(true);
  });
});

describe('publishing the real assembled build', () => {
  it('produces a package a client accepts, with production folders excluded', async () => {
    const share = scratch('real-share');
    const result = await publishUpdate({
      sourceDir: build.targetDir,
      targetDir: share,
      version: '0.2.0',
      build: 1,
      channel: 'test',
      releaseNotes: 'Real assembled TEST build, published by the automated suite.',
    });

    expect(result.ok).toBe(true);
    const manifest = readExistingManifest(share)!;
    expect(manifest.build).toBe(1);
    expect(manifest.architecture).toBe('win-x64');

    const packagePath = path.join(share, manifest.package);
    const bytes = fs.readFileSync(packagePath);
    expect(sha256(bytes)).toBe(manifest.sha256);
    expect(bytes.length).toBe(manifest.size);

    const entries = listZipEntries(packagePath);
    expect(inspectPackageEntries(entries).ok).toBe(true);
    for (const entry of entries) {
      const first = entry.split(/[\\/]/u)[0] as string;
      expect(['data', 'backups', 'reports', '.tnp-update', '.git', 'node_modules']).not.toContain(first);
    }
  }, 120_000);

  it('extracts to a staging folder that passes the client validation', async () => {
    const share = scratch('real-extract-share');
    await publishUpdate({
      sourceDir: build.targetDir,
      targetDir: share,
      version: '0.2.0',
      build: 1,
      channel: 'test',
    });
    const manifest = readExistingManifest(share)!;
    const staging = path.join(scratch('real-staging'), 'staging');

    extractZip(path.join(share, manifest.package), staging);

    for (const required of REQUIRED_PACKAGE_ENTRIES) {
      expect(fs.existsSync(path.join(staging, required)), `staging missing ${required}`).toBe(true);
    }
    const packaged = JSON.parse(fs.readFileSync(path.join(staging, 'resources', 'app', 'package.json'), 'utf8')) as
      { tnpBuild: number; version: string };
    expect(packaged.tnpBuild).toBe(1);
    expect(packaged.version).toBe('0.2.0');
  }, 120_000);

  it('collects the runtime without dragging in any persistent folder', () => {
    const destination = path.join(scratch('real-collect'), 'collected');
    // Production state left inside the portable folder by a previous test run must be ignored.
    fs.mkdirSync(path.join(build.targetDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(build.targetDir, 'data', 'tnp.db'), 'build machine test data');
    fs.mkdirSync(path.join(build.targetDir, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(build.targetDir, 'reports', 'a.pdf'), 'report');

    const entries = collectRuntimeForPackage(build.targetDir, destination);
    expect(entries).toContain('resources');
    expect(entries).not.toContain('data');
    expect(entries).not.toContain('reports');
    expect(entries).not.toContain('backups');
    expect(fs.existsSync(path.join(destination, 'data'))).toBe(false);
    expect(fs.existsSync(path.join(destination, 'resources', 'app', 'package.json'))).toBe(true);
    expect(inspectPackageEntries(listFiles(destination)).ok).toBe(true);

    // Clean up so the fixture stays representative for the next test.
    fs.rmSync(path.join(build.targetDir, 'data'), { recursive: true, force: true });
    fs.rmSync(path.join(build.targetDir, 'reports'), { recursive: true, force: true });
  }, 120_000);
});
