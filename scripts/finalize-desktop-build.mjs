import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Mirrors finalize-server-build.mjs: the source package is `"type": "module"` for Vite, but
 * the desktop wrapper and the preload are compiled to CommonJS because Electron's main and
 * preload runtimes require it. A nested package.json scopes that to the build output only.
 */
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'dist-desktop');

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
process.stdout.write('dist-desktop/package.json written (type: commonjs)\n');
