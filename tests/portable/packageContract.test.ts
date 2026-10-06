import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Contract between the three things that must agree for the portable build to launch:
 *   1. what tsconfig.desktop.json emits,
 *   2. what scripts/package-portable.mjs copies and names as the Electron entry,
 *   3. where desktop/main/main.ts looks for the preload.
 *
 * These are strings in different files, so drift here produces a folder that opens and
 * immediately dies. Asserting them together makes that a test failure instead.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

describe('portable package contract', () => {
  const desktopTsConfig = JSON.parse(read('tsconfig.desktop.json')) as {
    compilerOptions: { outDir: string; module: string };
    include: string[];
  };

  it('compiles the desktop wrapper to CommonJS into dist-desktop', () => {
    expect(desktopTsConfig.compilerOptions.outDir).toBe('dist-desktop');
    // Electron's main and preload runtimes require CommonJS here.
    expect(desktopTsConfig.compilerOptions.module).toBe('CommonJS');
    expect(desktopTsConfig.include).toContain('desktop/**/*.ts');
  });

  it('has the sources the packaged entry points at', () => {
    expect(existsSync(path.join(repoRoot, 'desktop/main/main.ts'))).toBe(true);
    expect(existsSync(path.join(repoRoot, 'desktop/preload/preload.ts'))).toBe(true);
    expect(existsSync(path.join(repoRoot, 'server/index.ts'))).toBe(true);
    expect(existsSync(path.join(repoRoot, 'src/data/legacy-base-data.json'))).toBe(true);
  });

  it('names an Electron entry that matches the compiled layout after copying', () => {
    const packager = read('scripts/package-portable.mjs');

    // The packager copies dist-desktop/desktop -> resources/app/dist, so the compiled
    // desktop/main/main.js lands at resources/app/dist/main/main.js.
    expect(packager).toContain("'dist-desktop', 'desktop'");
    expect(packager).toContain("main: 'dist/main/main.js'");

    // And main.ts must resolve the preload from dist/main/ to dist/preload/preload.js.
    const main = read('desktop/main/main.ts');
    expect(main).toContain("'..', 'preload', 'preload.js'");
  });

  it('copies the server runtime where the packaged path resolver looks for it', () => {
    const packager = read('scripts/package-portable.mjs');
    const paths = read('desktop/main/paths.ts');

    expect(packager).toContain("'dist-server'");
    expect(packager).toContain("'server-runtime'");
    expect(paths).toContain("'server-runtime', 'server', 'index.js'");
    expect(packager).toContain("'resources/app/server-runtime/server/index.js'");
  });

  it('ships the seed and the web bundle under the packaged names', () => {
    const packager = read('scripts/package-portable.mjs');
    const paths = read('desktop/main/paths.ts');

    expect(packager).toContain("'seed/legacy-base-data.json'");
    expect(paths).toContain("'seed', 'legacy-base-data.json'");
    expect(packager).toContain("'web'");
    expect(paths).toContain("'web'");
  });

  it('refuses to ship company data or runtime folders', () => {
    const packager = read('scripts/package-portable.mjs');
    expect(packager).toContain('EXCEL_EXPORT_FILE_20261002181424.xlsx');
    expect(packager).toContain('Refusing to ship');
    expect(packager).toContain('exactly 191 records');
  });

  it('never changes the pinned Electron version when the download is unavailable', () => {
    const packager = read('scripts/package-portable.mjs');
    expect(packager).toContain('BLOCKED');
    expect(packager).toContain('was NOT changed');
    // An ESM script cannot use require(); that would be a hard runtime failure.
    expect(packager).not.toContain('require(');
  });

  it('pins Electron in package.json so the build is reproducible', () => {
    const pkg = JSON.parse(read('package.json')) as {
      devDependencies: Record<string, string>;
      main: string;
      scripts: Record<string, string>;
    };
    expect(pkg.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(pkg.main).toBe('dist-desktop/desktop/main/main.js');
    expect(pkg.scripts['package:portable']).toContain('scripts/package-portable.mjs');
  });
});
