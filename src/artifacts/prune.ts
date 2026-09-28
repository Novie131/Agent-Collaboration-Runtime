import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MANIFEST_FILE, RunManifest } from './manifest.js';
import { readRunFile } from './store.js';

export interface PruneCandidate {
  runDir: string;
  artifactId: string;
  createdAt: string;
}

export function parseAge(s: string): number {
  const m = /^(\d+)(m|h|d)$/.exec(s);
  if (!m) throw new Error(`invalid age "${s}" (use e.g. 30m, 12h, 7d)`);
  const n = Number(m[1]);
  return n * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
}

/**
 * Lists run directories directly under `root` whose manifest is older than
 * `olderThanMs`. Deletes them only when `apply` is true. Never follows symlinks.
 */
export async function prune(root: string, olderThanMs: number, apply: boolean, now = Date.now()): Promise<{ candidates: PruneCandidate[]; deleted: string[] }> {
  const rootReal = await realpath(root);
  const entries = await readdir(rootReal, { withFileTypes: true });
  const candidates: PruneCandidate[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(rootReal, e.name);
    const st = await lstat(dir);
    if (st.isSymbolicLink()) continue;
    let manifest: RunManifest;
    try {
      manifest = RunManifest.parse(JSON.parse((await readRunFile(dir, MANIFEST_FILE)).toString('utf8')));
    } catch {
      continue; // not a run directory we created
    }
    const created = Date.parse(manifest.created_at);
    if (Number.isFinite(created) && now - created >= olderThanMs) {
      candidates.push({ runDir: dir, artifactId: manifest.artifact_id, createdAt: manifest.created_at });
    }
  }
  const deleted: string[] = [];
  if (apply) {
    for (const c of candidates) {
      await rm(c.runDir, { recursive: true, force: false });
      deleted.push(c.runDir);
    }
  }
  return { candidates, deleted };
}
