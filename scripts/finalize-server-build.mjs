import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package is `"type": "module"` for Vite, but the compiled server is CommonJS so its
 * extensionless relative imports keep resolving. A nested package.json scopes that to the
 * build output only, leaving the source package untouched.
 */
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'dist-server');

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
process.stdout.write('dist-server/package.json written (type: commonjs)\n');
