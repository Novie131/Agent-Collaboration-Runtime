import { realpathSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

/** Always denied; configuration may add globs but never remove these (SPEC §28.1). */
export const BUILTIN_DENY_GLOBS = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.gnupg/**',
  '**/.npmrc',
  '**/.netrc',
  '**/.git/**',
  '**/.agent-runtime/**',
];

export class BoundaryError extends Error {
  constructor(
    message: string,
    readonly code: 'OUT_OF_WORKSPACE' | 'DENIED' | 'NOT_FOUND',
  ) {
    super(message);
    this.name = 'BoundaryError';
  }
}

const matches = (p: string, globs: readonly string[]) =>
  globs.some((g) => posix.matchesGlob(p, g) || (g.startsWith('**/') && posix.matchesGlob(p, g.slice(3))));

/**
 * Resolves a workspace-relative path to an absolute one that is guaranteed to stay inside the
 * workspace after following symlinks, and is not on the deny-list. Returns the real path and the
 * normalized forward-slash relative path.
 */
export function resolveInWorkspace(root: string, relPath: string, extraDeny: readonly string[] = []): { abs: string; rel: string } {
  if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) throw new BoundaryError(`${relPath}: absolute paths are not allowed`, 'OUT_OF_WORKSPACE');
  const rootReal = realpathSync(root);
  const candidate = resolve(rootReal, relPath);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new BoundaryError(`${relPath}: no such file`, 'NOT_FOUND');
  }
  const rel = relative(rootReal, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new BoundaryError(`${relPath}: resolves outside the workspace`, 'OUT_OF_WORKSPACE');
  }
  const relPosix = rel.split(sep).join('/');
  const requested = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (matches(relPosix, [...BUILTIN_DENY_GLOBS, ...extraDeny]) || matches(requested, [...BUILTIN_DENY_GLOBS, ...extraDeny])) {
    throw new BoundaryError(`${relPath}: denied by the secret deny-list`, 'DENIED');
  }
  return { abs: real, rel: relPosix };
}

export const isDenied = (relPosix: string, extraDeny: readonly string[] = []) => matches(relPosix, [...BUILTIN_DENY_GLOBS, ...extraDeny]);
