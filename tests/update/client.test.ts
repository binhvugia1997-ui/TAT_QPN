/**
 * §29 — client updater tests.
 *
 * These run against real files in a real temporary filesystem. The manifest, the archive
 * reader, the hash, the copy loop, the install plan and the standalone helper are the actual
 * production modules; only Electron is replaced, by the injected `UpdateHost`.
 *
 * The property that matters most is asserted in almost every test: after a failed update the
 * production database is still byte-identical.
 */
import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ManifestError,
  assertSafePackageFileName,
  isSafePackageFileName,
  isNewerBuild,
  parseManifest,
} from '../../desktop/update/manifest';
import {
  PERSISTENT_DIR_NAMES,
  UPDATE_DIR_NAME,
  assertNotPreserved,
  isPreserved,
  runtimeEntryNames,
} from '../../desktop/update/layout';
import { checkForUpdate, createDismissalList, summariseCheck } from '../../desktop/update/checkForUpdate';
import { applyRuntime, backupRuntime, createInstallPlan, rollbackRuntime, verifyPreserved } from '../../desktop/update/install';
import { runHelper, isProcessRunning, layoutFromPlan, readHelperPlan } from '../../desktop/update/helperMain';
import type { HelperPlan } from '../../desktop/update/helperMain';
import { UpdateCoordinator } from '../../desktop/update/updaterCore';
import type { PackageSource, UpdateHost } from '../../desktop/update/updaterCore';
import { computePercent } from '../../desktop/update/transfer';
import { makeRuntimeZip, makeZip, manifestFixture, runtimeLayout } from './helpers';
import { PRODUCTION_BACKUP, PRODUCTION_DB, PRODUCTION_REPORT, createRuntimeFixture, createTempDir } from './helpers';

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** A LAN source backed by a real folder, so "unreachable" can be simulated by deleting it. */
function createSource(root: string, manifestText: string | null): PackageSource {
  fs.mkdirSync(root, { recursive: true });
  if (manifestText !== null) fs.writeFileSync(path.join(root, 'version.json'), manifestText, 'utf8');

  return {
    root,
    description: root,
    async readManifest() {
      return fs.promises.readFile(path.join(root, 'version.json'), 'utf8');
    },
    packagePath(name: string) {
      return path.join(root, assertSafePackageFileName(name));
    },
    async copyPackage(name, destination, onProgress) {
      const { copyFileWithProgress } = await import('../../desktop/update/transfer');
      const source = this.packagePath(name);
      if (!fs.existsSync(source)) throw new Error(`The update package "${name}" is not present at the update source.`);
      return copyFileWithProgress(source, destination, { onProgress, stage: 'COPYING', chunkSize: 64 * 1024 });
    },
  };
}

interface Harness {
  fixture: ReturnType<typeof createRuntimeFixture>;
  layout: ReturnType<typeof runtimeLayout>;
  share: string;
  host: UpdateHost & { logs: string[]; states: unknown[]; spawned: HelperPlan[]; quitReasons: string[] };
  coordinator: UpdateCoordinator;
  cleanup: () => void;
}

function createHarness(options: { localBuild?: number; channel?: string; version?: string; build?: number } = {}): Harness {
  const parent = createTempDir('client');
  const localBuild = options.localBuild ?? 6;
  const fixture = createRuntimeFixture(parent, {
    label: 'local',
    version: options.version,
    build: localBuild,
  });
  const layout = runtimeLayout(fixture);
  const share = fs.mkdtempSync(path.join(parent, 'share-'));

  const logs: string[] = [];
  const states: unknown[] = [];
  const spawned: HelperPlan[] = [];
  const quitReasons: string[] = [];

  const host = {
    logs,
    states,
    spawned,
    quitReasons,
    log: (line: string) => { logs.push(line); },
    emit: (state: unknown) => { states.push(state); },
    spawnHelper: (plan: HelperPlan) => { spawned.push(plan); return 4321; },
    quit: (reason: string) => { quitReasons.push(reason); },
    pid: () => 999,
    relaunchCommand: () => path.join(fixture.runtimeRoot, 'TNP Defect Management TEST.exe'),
    relaunchArgs: () => [],
  } satisfies UpdateHost & { logs: string[]; states: unknown[]; spawned: HelperPlan[]; quitReasons: string[] };

  const coordinator = new UpdateCoordinator({
    host,
    layout,
    local: { version: options.version ?? '0.2.0', build: localBuild },
    channel: options.channel ?? 'test',
  });

  return {
    fixture,
    layout,
    share,
    host,
    coordinator,
    cleanup: () => {
      fixture.cleanup();
      fs.rmSync(share, { recursive: true, force: true });
      fs.rmSync(parent, { recursive: true, force: true });
    },
  };
}

/** Publishes a valid update into the harness share and returns its manifest text. */
function publishFixtureUpdate(harness: Harness, overrides: { build?: number; version?: string } = {}): string {
  const sourceFixture = createRuntimeFixture(createTempDir('source'), {
    label: 'remote',
    version: overrides.version ?? '0.3.0',
    build: overrides.build ?? 7,
  });
  const zip = makeRuntimeZip(sourceFixture.runtimeRoot, {
    version: overrides.version ?? '0.3.0',
    build: overrides.build ?? 7,
  });
  sourceFixture.cleanup();

  const name = `tnp-test-${overrides.version ?? '0.3.0'}-build${overrides.build ?? 7}-win-x64.zip`;
  fs.writeFileSync(path.join(harness.share, name), zip);
  const manifest = manifestFixture({
    version: overrides.version ?? '0.3.0',
    build: overrides.build ?? 7,
    package: name,
    sha256: sha256(zip),
    size: zip.length,
  });
  const text = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(harness.share, 'version.json'), text, 'utf8');
  return text;
}

/* ------------------------------------------------------------------ */

describe('manifest validation', () => {
  it('accepts a complete, well-formed manifest', () => {
    const manifest = parseManifest(JSON.stringify(manifestFixture()));
    expect(manifest.product).toBe('TNP Defect Management System');
    expect(manifest.channel).toBe('test');
    expect(manifest.build).toBe(7);
    expect(manifest.architecture).toBe('win-x64');
    expect(manifest.package).toMatch(/\.zip$/u);
  });

  it('rejects every missing or wrongly typed required field', () => {
    const base = manifestFixture();
    for (const key of ['product', 'channel', 'version', 'build', 'architecture', 'package', 'sha256', 'size', 'publishedAt']) {
      const copy = { ...base };
      delete copy[key];
      expect(() => parseManifest(JSON.stringify(copy)), `missing ${key}`).toThrow(ManifestError);
    }
    expect(() => parseManifest(JSON.stringify({ ...base, build: '7' }))).toThrow(ManifestError);
    expect(() => parseManifest(JSON.stringify({ ...base, size: '1024' }))).toThrow(ManifestError);
    expect(() => parseManifest('[]')).toThrow(ManifestError);
    expect(() => parseManifest('not json')).toThrow(ManifestError);
  });

  it('rejects a manifest that is not this product or not this architecture', () => {
    expect(() => parseManifest(JSON.stringify(manifestFixture({ product: 'Some Other App' })))).toThrow(/product/u);
    expect(() => parseManifest(JSON.stringify(manifestFixture({ architecture: 'win-arm64' })))).toThrow(/architecture/u);
    expect(() => parseManifest(JSON.stringify(manifestFixture({ architecture: 'linux-x64' })))).toThrow(/architecture/u);
  });

  it('rejects a build that is not a positive integer', () => {
    for (const build of [0, -1, 1.5, Number.NaN]) {
      expect(() => parseManifest(JSON.stringify(manifestFixture({ build }))), `build ${build}`).toThrow(ManifestError);
    }
  });

  it('rejects a malformed sha256, size, timestamp or channel', () => {
    expect(() => parseManifest(JSON.stringify(manifestFixture({ sha256: 'a'.repeat(63) })))).toThrow(/sha256/u);
    expect(() => parseManifest(JSON.stringify(manifestFixture({ sha256: 'z'.repeat(64) })))).toThrow(/sha256/u);
    expect(() => parseManifest(JSON.stringify(manifestFixture({ size: 0 })))).toThrow(/size/u);
    expect(() => parseManifest(JSON.stringify(manifestFixture({ size: -5 })))).toThrow(/size/u);
    expect(() => parseManifest(JSON.stringify(manifestFixture({ publishedAt: '06/10/2026' })))).toThrow(/publishedAt/u);
    expect(() => parseManifest(JSON.stringify(manifestFixture({ channel: 'TEST' })))).toThrow(/channel/u);
    expect(() => parseManifest(JSON.stringify(manifestFixture({ channel: '' })))).toThrow(/channel/u);
  });

  it('keeps releaseNotes optional and bounded', () => {
    const withNotes = parseManifest(JSON.stringify(manifestFixture({ releaseNotes: 'Fixed the export.' })));
    expect(withNotes.releaseNotes).toBe('Fixed the export.');
    expect(() => parseManifest(JSON.stringify(manifestFixture({ releaseNotes: 42 })))).toThrow(/releaseNotes/u);
    expect(() => parseManifest(JSON.stringify(manifestFixture({ releaseNotes: 'x'.repeat(5000) })))).toThrow(/releaseNotes/u);
  });

  it('rejects an unknown extra field is ignored but an unknown top-level type is not', () => {
    // Extra fields are tolerated (forward compatibility); the wrong JSON type is not.
    expect(() => parseManifest(JSON.stringify(manifestFixture({ extra: true })))).not.toThrow();
    expect(() => parseManifest(JSON.stringify(null))).toThrow(ManifestError);
  });
});

describe('package name safety', () => {
  const hostile = [
    '../evil.zip',
    '..\\evil.zip',
    'a/../../evil.zip',
    '/etc/evil.zip',
    'C:\\Windows\\evil.zip',
    '\\\\server\\share\\evil.zip',
    'evil.zip/../../x',
    ' evil.zip',
    'evil.zip ',
    'evil',
    'evil.tar.gz',
    'evil\u0000.zip',
    '',
  ];

  it.each(hostile)('rejects the package name %s', (name) => {
    expect(isSafePackageFileName(name)).toBe(false);
    expect(() => assertSafePackageFileName(name)).toThrow(ManifestError);
  });

  it('accepts a plain zip file name', () => {
    expect(assertSafePackageFileName('tnp-test-0.3.0-build7-win-x64.zip')).toBe('tnp-test-0.3.0-build7-win-x64.zip');
  });

  it('refuses to resolve a hostile name outside the update source', () => {
    const harness = createHarness();
    try {
      const source = createSource(harness.share, null);
      expect(() => source.packagePath('../escape.zip')).toThrow(ManifestError);
    } finally {
      harness.cleanup();
    }
  });
});

describe('build ordering', () => {
  it('orders strictly on the integer build number', () => {
    expect(isNewerBuild(7, 6)).toBe(true);
    expect(isNewerBuild(6, 6)).toBe(false);
    expect(isNewerBuild(5, 6)).toBe(false);
    expect(isNewerBuild('7', 6)).toBe(false);
    expect(isNewerBuild(7.5, 6)).toBe(false);
    expect(isNewerBuild(undefined, 6)).toBe(false);
  });
});

describe('the startup check', () => {
  it('reports an available update when the remote build is newer', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      const result = await checkForUpdate(createSource(harness.share, null), {
        local: { version: '0.2.0', build: 6 },
        channel: 'test',
      });
      expect(result.status).toBe('update-available');
      if (result.status === 'update-available') {
        expect(result.remote.build).toBe(7);
        expect(result.remote.version).toBe('0.3.0');
      }
    } finally {
      harness.cleanup();
    }
  });

  it('does not prompt when the build is the same or the remote is older', async () => {
    const harness = createHarness();
    try {
      publishFixtureUpdate(harness, { build: 6 });
      const same = await checkForUpdate(createSource(harness.share, null), { local: { version: '0.2.0', build: 6 }, channel: 'test' });
      expect(same.status).toBe('same-build');

      publishFixtureUpdate(harness, { build: 5 });
      const older = await checkForUpdate(createSource(harness.share, null), { local: { version: '0.2.0', build: 6 }, channel: 'test' });
      expect(older.status).toBe('older-remote');
    } finally {
      harness.cleanup();
    }
  });

  it('treats an unreachable share as a soft failure and never throws', async () => {
    const harness = createHarness();
    try {
      const missing = path.join(harness.share, 'does-not-exist');
      const result = await checkForUpdate(createSource(missing, null), { local: { version: '0.2.0', build: 6 }, channel: 'test' });
      expect(result.status).toBe('unavailable');
      if (result.status === 'unavailable') {
        expect(result.reason).toMatch(/could not be found|could not be read|timed out|refused access/u);
      }
      // The failure must be describable without leaking a stack.
      expect(typeof summariseCheck(result).reason).toBe('string');
    } finally {
      harness.cleanup();
    }
  });

  it('treats a malformed manifest as a soft failure rather than an error', async () => {
    const harness = createHarness();
    try {
      fs.writeFileSync(path.join(harness.share, 'version.json'), '{"product":"nope"}', 'utf8');
      const result = await checkForUpdate(createSource(harness.share, null), { local: { version: '0.2.0', build: 6 }, channel: 'test' });
      expect(result.status).toBe('unavailable');
    } finally {
      harness.cleanup();
    }
  });

  it('ignores a manifest published for a different channel', async () => {
    const harness = createHarness();
    try {
      fs.writeFileSync(
        path.join(harness.share, 'version.json'),
        JSON.stringify(manifestFixture({ channel: 'production', build: 99 })),
        'utf8',
      );
      const result = await checkForUpdate(createSource(harness.share, null), { local: { version: '0.2.0', build: 6 }, channel: 'test' });
      expect(result.status).toBe('unavailable');
      if (result.status === 'unavailable') expect(result.reason).toMatch(/channel/u);
    } finally {
      harness.cleanup();
    }
  });

  it('never resolves the check later than its timeout', async () => {
    const harness = createHarness();
    try {
      const slow = {
        description: 'slow',
        readManifest: () => new Promise<string>((resolve) => { setTimeout(() => resolve('{}'), 5_000); }),
      };
      const started = Date.now();
      const result = await checkForUpdate(slow, { local: { version: '0.2.0', build: 6 }, channel: 'test', timeoutMs: 120 });
      expect(result.status).toBe('unavailable');
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      harness.cleanup();
    }
  });

  it('suppresses a dismissed build for the session only', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      harness.coordinator.configure(createSource(harness.share, null));

      await harness.coordinator.check();
      expect(harness.coordinator.getState().phase).toBe('update-available');

      harness.coordinator.dismiss();
      expect(harness.coordinator.getState().phase).toBe('idle');

      // The same build must not be offered again in this session…
      await harness.coordinator.check();
      expect(harness.coordinator.getState().phase).toBe('idle');

      // …but a fresh session must be allowed to remind the owner.
      const fresh = createDismissalList();
      expect(fresh.isDismissed(7)).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('stays disabled, without error, when no source is configured', async () => {
    const harness = createHarness();
    try {
      harness.coordinator.configure(null);
      expect(await harness.coordinator.check()).toBeNull();
      expect(harness.coordinator.getState().phase).toBe('disabled');
      expect(harness.coordinator.getState().error).toBeNull();
    } finally {
      harness.cleanup();
    }
  });
});

describe('the install path', () => {
  it('copies with real byte progress, verifies, validates, stages and hands over', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();

      const dbBefore = fs.readFileSync(harness.fixture.dbFile);
      await harness.coordinator.install();

      // Real progress: at least one intermediate report plus the final one.
      const progressReports = harness.host.states
        .map((state) => (state as { progress: { bytesTransferred: number; percent: number; stage: string } | null }).progress)
        .filter((progress): progress is { bytesTransferred: number; percent: number; stage: string } => progress !== null);
      expect(progressReports.length).toBeGreaterThan(1);
      expect(progressReports[progressReports.length - 1]!.percent).toBe(100);
      const percents = progressReports.map((entry) => entry.percent);
      expect(percents).toEqual([...percents].sort((a, b) => a - b));
      expect(computePercent(1, 4)).toBe(25);

      // Stages ran in the documented order.
      const stages = harness.host.states
        .map((state) => (state as { stage: string | null }).stage)
        .filter((stage): stage is string => stage !== null);
      const order = ['COPYING', 'VERIFYING', 'VALIDATING', 'STAGING', 'WAITING_FOR_EXIT', 'INSTALLING'];
      for (const stage of order) expect(stages).toContain(stage);
      expect(stages.indexOf('COPYING')).toBeLessThan(stages.indexOf('VERIFYING'));
      expect(stages.indexOf('VERIFYING')).toBeLessThan(stages.indexOf('VALIDATING'));
      expect(stages.indexOf('VALIDATING')).toBeLessThan(stages.indexOf('STAGING'));
      expect(stages.indexOf('STAGING')).toBeLessThan(stages.indexOf('WAITING_FOR_EXIT'));

      // The helper was handed a plan, and TNP was asked to close.
      expect(harness.host.spawned).toHaveLength(1);
      expect(harness.host.spawned[0]!.targetBuild).toBe(7);
      expect(harness.host.spawned[0]!.previousBuild).toBe(6);
      expect(harness.host.quitReasons).toHaveLength(1);

      // The staged runtime exists and the plan file was written.
      expect(fs.existsSync(path.join(harness.layout.stagingDir, 'TNP Defect Management TEST.exe'))).toBe(true);
      expect(fs.existsSync(harness.layout.planFile)).toBe(true);
      const plan = readHelperPlan(harness.layout.planFile);
      expect(plan.runtimeEntries).not.toContain('data');
      expect(plan.runtimeEntries).not.toContain('backups');
      expect(plan.runtimeEntries).not.toContain('reports');
      expect(plan.runtimeEntries).not.toContain(UPDATE_DIR_NAME);

      // Nothing was installed yet, and production data is untouched.
      expect(fs.readFileSync(harness.fixture.dbFile).equals(dbBefore)).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(harness.fixture.runtimeRoot, 'resources/app/package.json'), 'utf8')).tnpBuild).toBe(6);
    } finally {
      harness.cleanup();
    }
  });

  it('refuses to install after a SHA256 mismatch and leaves the running runtime alone', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      // Corrupt the published package after the manifest was written.
      const name = JSON.parse(fs.readFileSync(path.join(harness.share, 'version.json'), 'utf8')).package as string;
      const packagePath = path.join(harness.share, name);
      fs.appendFileSync(packagePath, Buffer.from('tampered'));

      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();

      const dbBefore = fs.readFileSync(harness.fixture.dbFile);
      const launcherBefore = fs.readFileSync(path.join(harness.fixture.runtimeRoot, 'TNP Defect Management TEST.exe'));

      await expect(harness.coordinator.install()).rejects.toThrow(/SHA256/u);
      expect(harness.coordinator.getState().phase).toBe('failed');
      expect(harness.coordinator.getState().stage).toBe('FAILED');
      expect(harness.host.spawned).toHaveLength(0);
      expect(harness.host.quitReasons).toHaveLength(0);

      // The tampered download was removed and the runtime is byte-identical.
      expect(fs.existsSync(path.join(harness.layout.downloadDir, name))).toBe(false);
      expect(fs.readFileSync(harness.fixture.dbFile).equals(dbBefore)).toBe(true);
      expect(fs.readFileSync(path.join(harness.fixture.runtimeRoot, 'TNP Defect Management TEST.exe')).equals(launcherBefore)).toBe(true);
      expect(fs.existsSync(harness.layout.stagingDir)).toBe(true);
      expect(fs.readdirSync(harness.layout.stagingDir)).toHaveLength(0);
    } finally {
      harness.cleanup();
    }
  });

  it('refuses to install when the size does not match the manifest', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      const manifestPath = path.join(harness.share, 'version.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.size = Number(manifest.size) + 1;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();
      await expect(harness.coordinator.install()).rejects.toThrow(/bytes/u);
      expect(harness.host.spawned).toHaveLength(0);
    } finally {
      harness.cleanup();
    }
  });

  it('rejects a ZIP-slip package before extracting anything', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      const evilOutside = path.join(path.dirname(harness.fixture.runtimeRoot), 'evil.txt');
      const zip = makeZip([
        { name: 'TNP Defect Management TEST.exe', content: 'stub' },
        { name: '../../evil.txt', content: 'escaped the staging directory' },
      ]);
      const name = 'hostile.zip';
      fs.writeFileSync(path.join(harness.share, name), zip);
      fs.writeFileSync(
        path.join(harness.share, 'version.json'),
        JSON.stringify(manifestFixture({ build: 7, package: name, sha256: sha256(zip), size: zip.length }), null, 2),
        'utf8',
      );

      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();
      await expect(harness.coordinator.install()).rejects.toThrow(/unsafe paths|unsafe/u);

      expect(fs.existsSync(evilOutside)).toBe(false);
      expect(fs.readdirSync(harness.layout.stagingDir)).toHaveLength(0);
      expect(harness.host.spawned).toHaveLength(0);
    } finally {
      harness.cleanup();
    }
  });

  it('rejects a package that carries production data', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      // A package that smuggles the build machine's data folder alongside a valid runtime.
      const hostile = makeZip([
        { name: 'TNP Defect Management TEST.exe', content: 'stub' },
        { name: 'resources/app/package.json', content: '{}' },
        { name: 'data/tnp.db', content: 'the build machine test database' },
      ]);
      const name = 'leaky.zip';
      fs.writeFileSync(path.join(harness.share, name), hostile);
      fs.writeFileSync(
        path.join(harness.share, 'version.json'),
        JSON.stringify(manifestFixture({ build: 7, package: name, sha256: sha256(hostile), size: hostile.length }), null, 2),
        'utf8',
      );

      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();
      await expect(harness.coordinator.install()).rejects.toThrow(/forbidden production content/u);

      // The owner's database was never at risk.
      expect(fs.readFileSync(harness.fixture.dbFile).equals(PRODUCTION_DB)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('rejects a package that is not a complete TNP runtime', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      const partial = makeZip([
        { name: 'TNP Defect Management TEST.exe', content: 'stub' },
        { name: 'resources/app/package.json', content: '{}' },
      ]);
      const name = 'partial.zip';
      fs.writeFileSync(path.join(harness.share, name), partial);
      fs.writeFileSync(
        path.join(harness.share, 'version.json'),
        JSON.stringify(manifestFixture({ build: 7, package: name, sha256: sha256(partial), size: partial.length }), null, 2),
        'utf8',
      );

      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();
      await expect(harness.coordinator.install()).rejects.toThrow(/missing runtime files/u);
    } finally {
      harness.cleanup();
    }
  });

  it('rejects a package whose staged version does not match the manifest', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      // Rewrite the manifest to announce a different build than the package contains.
      const manifestPath = path.join(harness.share, 'version.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.version = '9.9.9';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();
      await expect(harness.coordinator.install()).rejects.toThrow(/staged runtime is/u);
    } finally {
      harness.cleanup();
    }
  });

  it('refuses to install when nothing is available', async () => {
    const harness = createHarness({ localBuild: 7 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();
      await expect(harness.coordinator.install()).rejects.toThrow(/No update is available/u);
    } finally {
      harness.cleanup();
    }
  });
});

describe('runtime replacement and rollback', () => {
  it('backs up the runtime, installs the new one and preserves production data byte-for-byte', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();
      await harness.coordinator.install();

      const dbBefore = fs.readFileSync(harness.fixture.dbFile);
      const backupBefore = fs.readFileSync(harness.fixture.backupFile);
      const reportBefore = fs.readFileSync(harness.fixture.reportFile);

      const layout = harness.layout;
      const plan = createInstallPlan({ layout, stagedDir: layout.stagingDir, previousBuild: 6, targetBuild: 7 });
      expect(plan.runtimeEntries).toContain('resources');
      expect(plan.runtimeEntries).toContain('TNP Defect Management TEST.exe');

      const backup = backupRuntime(plan, layout);
      expect(backup.ok).toBe(true);
      expect(fs.existsSync(path.join(plan.backupDir, 'resources', 'app', 'package.json'))).toBe(true);

      const applied = applyRuntime(plan, layout);
      expect(applied.ok).toBe(true);

      // The runtime is now build 7…
      const installed = JSON.parse(
        fs.readFileSync(path.join(harness.fixture.runtimeRoot, 'resources/app/package.json'), 'utf8'),
      ) as { tnpBuild: number };
      expect(installed.tnpBuild).toBe(7);

      // …and production data is unchanged, byte for byte.
      expect(fs.readFileSync(harness.fixture.dbFile).equals(dbBefore)).toBe(true);
      expect(fs.readFileSync(harness.fixture.backupFile).equals(backupBefore)).toBe(true);
      expect(fs.readFileSync(harness.fixture.reportFile).equals(reportBefore)).toBe(true);
      expect(fs.readFileSync(harness.fixture.settingsFile, 'utf8')).toBe('{"lanEnabled":false,"port":8787,"workstationLabel":"OWNER-PC"}');
      expect(verifyPreserved(layout).ok).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('restores the previous runtime on failure and never restores a database', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();
      await harness.coordinator.install();

      const layout = harness.layout;
      const plan = createInstallPlan({ layout, stagedDir: layout.stagingDir, previousBuild: 6, targetBuild: 7 });
      backupRuntime(plan, layout);

      // Simulate a corrupted install: put a broken runtime in place, then roll back.
      const dbBefore = fs.readFileSync(harness.fixture.dbFile);
      const marker = path.join(harness.fixture.runtimeRoot, 'resources', 'app', 'CORRUPTED');
      fs.writeFileSync(marker, 'broken');
      fs.rmSync(path.join(harness.fixture.runtimeRoot, 'resources', 'app', 'web'), { recursive: true, force: true });

      const rolled = rollbackRuntime(plan, layout);
      expect(rolled.ok).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.existsSync(path.join(harness.fixture.runtimeRoot, 'resources', 'app', 'web', 'index.html'))).toBe(true);

      const restored = JSON.parse(
        fs.readFileSync(path.join(harness.fixture.runtimeRoot, 'resources/app/package.json'), 'utf8'),
      ) as { tnpBuild: number };
      expect(restored.tnpBuild).toBe(6);

      // The database was never replaced, and no backup was ever restored over it.
      expect(fs.readFileSync(harness.fixture.dbFile).equals(dbBefore)).toBe(true);
      expect(fs.readFileSync(harness.fixture.dbFile).equals(PRODUCTION_DB)).toBe(true);
      expect(fs.readFileSync(harness.fixture.backupFile, 'utf8')).toBe(PRODUCTION_BACKUP);
      expect(fs.readFileSync(harness.fixture.reportFile, 'utf8')).toBe(PRODUCTION_REPORT);
    } finally {
      harness.cleanup();
    }
  });

  it('refuses to plan, back up or apply anything inside the persistent directories', () => {
    const harness = createHarness();
    try {
      const layout = harness.layout;
      for (const dir of [harness.fixture.dataDir, harness.fixture.backupsDir, harness.fixture.reportsDir, harness.layout.updateDir]) {
        expect(isPreserved(dir, layout)).toBe(true);
        expect(isPreserved(path.join(dir, 'anything', 'deeper.txt'), layout)).toBe(true);
        expect(() => assertNotPreserved(dir, layout, 'delete')).toThrow(/production data/u);
        expect(() => assertNotPreserved(path.join(dir, 'x.txt'), layout, 'overwrite')).toThrow(/production data/u);
      }
      expect(isPreserved(path.join(harness.fixture.runtimeRoot, 'resources'), layout)).toBe(false);
      expect(PERSISTENT_DIR_NAMES).toEqual(['data', 'backups', 'reports']);
    } finally {
      harness.cleanup();
    }
  });

  it('excludes persistent and working directories from the runtime entry list', () => {
    const harness = createHarness();
    try {
      fs.mkdirSync(harness.layout.updateDir, { recursive: true });
      const entries = runtimeEntryNames(
        fs.readdirSync(harness.fixture.runtimeRoot),
        harness.layout,
      );
      expect(entries).toContain('resources');
      expect(entries).toContain('TNP Defect Management TEST.exe');
      for (const forbidden of ['data', 'backups', 'reports', UPDATE_DIR_NAME]) {
        expect(entries).not.toContain(forbidden);
      }
    } finally {
      harness.cleanup();
    }
  });

  it('refuses to plan an install when there is no staged runtime', () => {
    const harness = createHarness();
    try {
      expect(() => createInstallPlan({
        layout: harness.layout,
        stagedDir: path.join(harness.layout.updateDir, 'missing'),
        previousBuild: 6,
        targetBuild: 7,
      })).toThrow(/does not exist/u);
    } finally {
      harness.cleanup();
    }
  });

  it('refuses to apply a staged runtime that contains production data', () => {
    const harness = createHarness();
    try {
      const staged = path.join(harness.layout.stagingDir);
      fs.mkdirSync(path.join(staged, 'data'), { recursive: true });
      fs.writeFileSync(path.join(staged, 'data', 'tnp.db'), 'build machine test data');
      fs.mkdirSync(path.join(staged, 'resources'), { recursive: true });

      const plan = createInstallPlan({ layout: harness.layout, stagedDir: staged, previousBuild: 6, targetBuild: 7 });
      expect(() => applyRuntime(plan, harness.layout)).toThrow(/production data/u);
      expect(fs.readFileSync(harness.fixture.dbFile).equals(PRODUCTION_DB)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });
});

describe('the standalone updater helper', () => {
  function planFrom(harness: Harness): HelperPlan {
    return {
      runtimeRoot: harness.fixture.runtimeRoot,
      updateDir: harness.layout.updateDir,
      planFile: harness.layout.planFile,
      stagedDir: harness.layout.stagingDir,
      backupRoot: harness.layout.runtimeBackupDir,
      runtimeEntries: ['resources', 'TNP Defect Management TEST.exe'],
      previousBuild: 6,
      targetBuild: 7,
      waitForPid: 999,
      waitForExitMs: 200,
      relaunchCommand: path.join(harness.fixture.runtimeRoot, 'TNP Defect Management TEST.exe'),
      relaunchArgs: [],
      relaunchCwd: harness.fixture.runtimeRoot,
      logFile: harness.layout.updateLogFile,
      resultFile: path.join(harness.layout.updateDir, 'last-update-result.json'),
    };
  }

  it('waits for TNP to exit, swaps the runtime and relaunches', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();
      await harness.coordinator.install();

      const plan = planFrom(harness);
      const dbBefore = fs.readFileSync(harness.fixture.dbFile);
      let relaunched = 0;
      const lines: string[] = [];

      const result = await runHelper({
        plan,
        sleep: async () => undefined,
        relaunch: () => { relaunched += 1; },
        log: (line) => { lines.push(line); },
      });

      expect(result.ok).toBe(true);
      expect(result.stage).toBe('COMPLETE');
      expect(relaunched).toBe(1);
      expect(lines.join('\n')).toMatch(/waiting for TNP/u);

      const installed = JSON.parse(
        fs.readFileSync(path.join(harness.fixture.runtimeRoot, 'resources/app/package.json'), 'utf8'),
      ) as { tnpBuild: number };
      expect(installed.tnpBuild).toBe(7);
      expect(fs.readFileSync(harness.fixture.dbFile).equals(dbBefore)).toBe(true);
      expect(fs.readFileSync(harness.fixture.reportFile, 'utf8')).toBe(PRODUCTION_REPORT);
      expect(fs.existsSync(path.join(harness.layout.runtimeBackupDir, 'runtime-build7'))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('abandons the update, leaving the runtime untouched, when TNP will not exit', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();
      await harness.coordinator.install();

      const plan = { ...planFrom(harness), waitForPid: process.pid, waitForExitMs: 120 };
      const result = await runHelper({ plan, relaunch: () => undefined });

      expect(result.ok).toBe(false);
      expect(result.stage).toBe('FAILED');
      expect(result.rolledBack).toBe(false);
      // Nothing was moved: still build 6, database intact.
      const installed = JSON.parse(
        fs.readFileSync(path.join(harness.fixture.runtimeRoot, 'resources/app/package.json'), 'utf8'),
      ) as { tnpBuild: number };
      expect(installed.tnpBuild).toBe(6);
      expect(fs.readFileSync(harness.fixture.dbFile).equals(PRODUCTION_DB)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('rolls the runtime back when the install itself fails', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();
      await harness.coordinator.install();

      // Break the staged runtime so applyRuntime throws after the backup exists.
      fs.rmSync(harness.layout.stagingDir, { recursive: true, force: true });

      const plan = planFrom(harness);
      const result = await runHelper({ plan, relaunch: () => undefined });

      expect(result.ok).toBe(false);
      expect(result.stage).toBe('ROLLBACK');
      // The backup had already been taken, so the previous runtime was put back.
      expect(result.rolledBack).toBe(true);
      expect(fs.existsSync(path.join(harness.fixture.runtimeRoot, 'resources', 'app', 'web', 'index.html'))).toBe(true);
      expect(fs.readFileSync(harness.fixture.dbFile).equals(PRODUCTION_DB)).toBe(true);
      const installed = JSON.parse(
        fs.readFileSync(path.join(harness.fixture.runtimeRoot, 'resources/app/package.json'), 'utf8'),
      ) as { tnpBuild: number };
      expect(installed.tnpBuild).toBe(6);
    } finally {
      harness.cleanup();
    }
  });

  it('derives a guarded layout from the plan, so production paths stay protected', () => {
    const harness = createHarness();
    try {
      const layout = layoutFromPlan(planFrom(harness));
      expect(layout.preservedDirs).toContain(path.join(harness.fixture.runtimeRoot, 'data'));
      expect(layout.preservedDirs).toContain(path.join(harness.fixture.runtimeRoot, 'backups'));
      expect(layout.preservedDirs).toContain(path.join(harness.fixture.runtimeRoot, 'reports'));
      expect(isPreserved(harness.fixture.dbFile, layout)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('requires a plan file and validates its contents', () => {
    const harness = createHarness();
    try {
      fs.mkdirSync(harness.layout.updateDir, { recursive: true });
      const file = path.join(harness.layout.updateDir, 'bad-plan.json');
      fs.writeFileSync(file, JSON.stringify({ runtimeRoot: harness.fixture.runtimeRoot }), 'utf8');
      expect(() => readHelperPlan(file)).toThrow(/missing/u);
      expect(isProcessRunning(0)).toBe(false);
      expect(isProcessRunning(process.pid)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('writes a result file the restarted app can report', async () => {
    const harness = createHarness({ localBuild: 6 });
    try {
      publishFixtureUpdate(harness, { build: 7 });
      harness.coordinator.configure(createSource(harness.share, null));
      await harness.coordinator.check();
      await harness.coordinator.install();

      const plan = planFrom(harness);
      const { main } = await import('../../desktop/update/helperMain');
      const code = await main(['--plan', harness.layout.planFile], { relaunch: () => undefined });
      expect(code).toBe(0);

      const written = JSON.parse(
        fs.readFileSync(path.join(harness.layout.updateDir, 'last-update-result.json'), 'utf8'),
      ) as { ok: boolean; stage: string; targetBuild: number };
      expect(written.ok).toBe(true);
      expect(written.stage).toBe('COMPLETE');
      expect(written.targetBuild).toBe(7);
      expect(fs.existsSync(harness.layout.updateLogFile)).toBe(true);

      // A fresh coordinator reports the outcome of the previous run.
      const reported = createHarness({ localBuild: 7 });
      try {
        fs.copyFileSync(
          path.join(harness.layout.updateDir, 'last-update-result.json'),
          (() => {
            fs.mkdirSync(reported.layout.updateDir, { recursive: true });
            return path.join(reported.layout.updateDir, 'last-update-result.json');
          })(),
        );
        reported.coordinator.loadLastResult();
        expect(reported.coordinator.getState().phase).toBe('complete');
        expect(reported.coordinator.getState().lastResult?.targetBuild).toBe(7);
      } finally {
        reported.cleanup();
      }
    } finally {
      harness.cleanup();
    }
  });
});

describe('the updater working area', () => {
  it('keeps packages, staging and rollback copies outside data, backups and reports', () => {
    const harness = createHarness();
    try {
      const { layout } = harness;
      expect(layout.updateDir).toBe(path.join(harness.fixture.runtimeRoot, UPDATE_DIR_NAME));
      for (const working of [layout.downloadDir, layout.stagingDir, layout.runtimeBackupDir, layout.planFile, layout.updateLogFile]) {
        expect(working.startsWith(layout.updateDir)).toBe(true);
        expect(working.startsWith(harness.fixture.dataDir)).toBe(false);
        expect(working.startsWith(harness.fixture.backupsDir)).toBe(false);
        expect(working.startsWith(harness.fixture.reportsDir)).toBe(false);
      }
    } finally {
      harness.cleanup();
    }
  });

  it('cleans the working area without touching anything else', () => {
    const harness = createHarness();
    try {
      fs.mkdirSync(harness.layout.downloadDir, { recursive: true });
      fs.writeFileSync(path.join(harness.layout.downloadDir, 'leftover.zip'), 'junk');
      harness.coordinator.cleanWorkingArea();
      expect(fs.existsSync(harness.layout.downloadDir)).toBe(false);
      expect(fs.existsSync(harness.fixture.dbFile)).toBe(true);
      expect(fs.existsSync(path.join(harness.fixture.runtimeRoot, 'resources'))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });
});
