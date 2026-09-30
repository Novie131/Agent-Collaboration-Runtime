import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ARTIFACT_ID_RE, MANIFEST_FILE, PART_FILES, RunManifest, type StoredPart } from './manifest.js';

export class ArtifactError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'hash_mismatch' | 'invalid_id' | 'unsafe_path' | 'run_dir_exists' | 'io',
  ) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export function newArtifactId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `ae_${ts}_${randomBytes(4).toString('hex')}`;
}

/** Creates a fresh run directory; refuses to reuse an existing one. */
export async function createRunDir(runDir: string): Promise<string> {
  const abs = resolve(runDir);
  await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
  try {
    await mkdir(abs, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ArtifactError(`run-dir ${runDir} already exists; use a new directory per run`, 'run_dir_exists');
    }
    throw new ArtifactError(`cannot create run-dir ${runDir}: ${(err as Error).message}`, 'io');
  }
  return realpath(abs);
}

export function runDirPaths(runDirReal: string) {
  return {
    stdoutPath: join(runDirReal, PART_FILES.stdout),
    stderrPath: join(runDirReal, PART_FILES.stderr),
    jsonPath: join(runDirReal, PART_FILES.result),
    viewPath: join(runDirReal, PART_FILES.view),
    manifestPath: join(runDirReal, MANIFEST_FILE),
  };
}

/** Exclusive create, no symlink following, owner-only permissions, fsync. */
export async function writeNewFile(path: string, data: Buffer | string): Promise<void> {
  const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Reads a file that must be a regular, non-symlink file directly inside runDirReal. */
export async function readRunFile(runDirReal: string, name: string): Promise<Buffer> {
  if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') {
    throw new ArtifactError(`unsafe file name ${name}`, 'unsafe_path');
  }
  const p = join(runDirReal, name);
  let st;
  try {
    st = await lstat(p);
  } catch {
    throw new ArtifactError(`${name} is missing from the run directory`, 'not_found');
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new ArtifactError(`${name} is not a regular file (symlinks are refused)`, 'unsafe_path');
  const fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

export async function hashFile(runDirReal: string, name: string): Promise<{ sha256: string; bytes: number }> {
  const b = await readRunFile(runDirReal, name);
  return { sha256: sha256Hex(b), bytes: b.length };
}

export interface OpenedRun {
  runDirReal: string;
  manifest: RunManifest;
}

/**
 * Resolves an artifact by ID inside an explicitly given run directory. The ID is
 * validated by pattern and compared with the manifest; it is never used as a path.
 */
export async function openRun(runDir: string, artifactId: string): Promise<OpenedRun> {
  if (!ARTIFACT_ID_RE.test(artifactId)) throw new ArtifactError(`invalid artifact id "${artifactId}"`, 'invalid_id');
  let runDirReal: string;
  try {
    const st = await lstat(runDir);
    if (st.isSymbolicLink()) throw new ArtifactError('run-dir must not be a symlink', 'unsafe_path');
    if (!st.isDirectory()) throw new ArtifactError('run-dir is not a directory', 'not_found');
    runDirReal = await realpath(runDir);
  } catch (err) {
    if (err instanceof ArtifactError) throw err;
    throw new ArtifactError(`run-dir ${runDir} not found`, 'not_found');
  }
  const raw = await readRunFile(runDirReal, MANIFEST_FILE);
  let manifest: RunManifest;
  try {
    manifest = RunManifest.parse(JSON.parse(raw.toString('utf8')));
  } catch (err) {
    throw new ArtifactError(`manifest is invalid: ${(err as Error).message.slice(0, 200)}`, 'io');
  }
  if (manifest.artifact_id !== artifactId) throw new ArtifactError(`artifact ${artifactId} is not in this run-dir`, 'not_found');
  return { runDirReal, manifest };
}

/** Reads a stored part and verifies it against the manifest hash. */
export async function readVerifiedPart(run: OpenedRun, part: StoredPart): Promise<Buffer> {
  const entry = run.manifest.files[part];
  if (!entry) throw new ArtifactError(`part ${part} was not stored for this run`, 'not_found');
  if (entry.file !== PART_FILES[part]) throw new ArtifactError(`manifest points ${part} at an unexpected file`, 'unsafe_path');
  const data = await readRunFile(run.runDirReal, entry.file);
  if (data.length !== entry.bytes || sha256Hex(data) !== entry.sha256) {
    throw new ArtifactError(`${entry.file} does not match the manifest hash; the artifact was modified or damaged`, 'hash_mismatch');
  }
  return data;
}
