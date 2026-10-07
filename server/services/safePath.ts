import fs from 'node:fs';
import path from 'node:path';
import { StorageSecurityError } from '../errors';

/**
 * Containment is enforced twice: once on the lexical path and once on the real path, so a
 * directory or file symlink inside managed storage cannot point outside it.
 */
export function assertInsideRoot(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StorageSecurityError('The requested path is outside the managed storage directory.');
  }
}

export function resolveContainedPath(root: string, name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new StorageSecurityError('A stored file name is required.');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new StorageSecurityError('A stored file name must not contain a path separator.');
  }
  if (name === '.' || name === '..' || name.startsWith('..')) {
    throw new StorageSecurityError('A stored file name must not traverse directories.');
  }
  if (path.isAbsolute(name) || /^[A-Za-z]:/u.test(name)) {
    throw new StorageSecurityError('A stored file name must not be an absolute path.');
  }

  const candidate = path.resolve(root, name);
  assertInsideRoot(path.resolve(root), candidate);
  return candidate;
}

/**
 * Resolves a stored name and verifies that the *real* location is still inside the real
 * managed directory. This is what rejects symlink escapes.
 */
export function resolveRealContainedPath(root: string, name: string): string {
  const candidate = resolveContainedPath(root, name);

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    throw new StorageSecurityError('The managed storage directory is not available.');
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(candidate);
  } catch {
    // Missing file: the lexical containment check above already applied.
    return candidate;
  }

  assertInsideRoot(realRoot, realTarget);
  return realTarget;
}

/** Keeps only characters that are safe in a file name on Windows and POSIX systems. */
export function toSafeFileComponent(value: string, maxLength = 64): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[\\/]+/gu, '-')
    .replace(/[^A-Za-z0-9._\-\u00c0-\u1ef9]/gu, '_')
    // Collapse dot runs so no component can ever spell a traversal sequence.
    .replace(/\.{2,}/gu, '.')
    .replace(/^[.\-_]+/u, '')
    .slice(0, maxLength);
  return cleaned || 'file';
}

/**
 * Containment for **nested** read-only trees, used by the static bundle server where files
 * legitimately live in subfolders such as `assets/`.
 *
 * This is deliberately a separate function from `resolveContainedPath`, which forbids path
 * separators entirely and is the right rule for flat managed storage (reports, backups).
 * Reusing that rule for the web bundle made every `/assets/...` request fail, and the static
 * handler answered with `index.html` and HTTP 200 — the browser then refused to execute HTML
 * as a module and the window rendered blank.
 *
 * Traversal, absolute paths, drive letters and symlink escapes are still rejected here.
 */
export function resolveContainedSubPath(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new StorageSecurityError('A relative path is required.');
  }
  if (relativePath.includes('\0')) {
    throw new StorageSecurityError('The requested path contains an invalid character.');
  }
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:/u.test(relativePath)) {
    throw new StorageSecurityError('The requested path must not be absolute.');
  }

  // Accept either separator, then reject any component that could escape the root.
  const segments = relativePath.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new StorageSecurityError('The requested path is empty.');
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new StorageSecurityError('The requested path must not traverse directories.');
    }
  }

  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  assertInsideRoot(resolvedRoot, candidate);

  // Second check on the real path, so a symlink inside the tree cannot point outside it.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(resolvedRoot);
  } catch {
    throw new StorageSecurityError('The served directory is not available.');
  }
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(candidate);
  } catch {
    // Missing file: the lexical containment check above already applied.
    return candidate;
  }
  assertInsideRoot(realRoot, realTarget);
  return realTarget;
}
