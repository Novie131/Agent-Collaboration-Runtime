import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliGitReader } from '@acr/git/git-reader.js';

const hasGit = spawnSync('git', ['--version'], { shell: false }).status === 0;
let repo: string;
let ws: string;

const git = (...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=t', ...args], { cwd: repo, shell: false, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'acr-git-'));
  ws = join(repo, 'services', 'api'); // workspace below the git root
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.ts'), 'a\n');
  writeFileSync(join(ws, 'src', 'b.ts'), 'b\n');
  writeFileSync(join(repo, 'outside.txt'), 'x\n');
  if (hasGit) {
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'init');
  }
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe.skipIf(!hasGit)('CliGitReader', () => {
  it('reports workspace-relative changes since the claim, ignoring edits made before it', async () => {
    writeFileSync(join(ws, 'src', 'b.ts'), 'b edited before claim\n');
    writeFileSync(join(repo, 'outside.txt'), 'outside the workspace\n');
    const reader = new CliGitReader(ws);
    const snap = await reader.snapshot();
    expect(Object.keys(snap.dirty)).toEqual(['src/b.ts']);

    writeFileSync(join(ws, 'src', 'a.ts'), 'a changed\n');
    writeFileSync(join(ws, 'src', 'new.ts'), 'new\n');
    expect(await reader.changedSince(snap)).toEqual(['src/a.ts', 'src/new.ts']);

    const diff = await reader.diff(snap);
    expect(diff).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(diff).toContain('+a changed');
    expect(diff).toContain('+++ b/src/new.ts');
    expect(diff).not.toContain('outside');
  });

  it('counts further edits to a pre-dirty file, and reverting it', async () => {
    writeFileSync(join(ws, 'src', 'b.ts'), 'dirty\n');
    const reader = new CliGitReader(ws);
    const snap = await reader.snapshot();
    writeFileSync(join(ws, 'src', 'b.ts'), 'dirty and edited again\n');
    expect(await reader.changedSince(snap)).toEqual(['src/b.ts']);
    writeFileSync(join(ws, 'src', 'b.ts'), 'b\n'); // back to HEAD
    expect(await reader.changedSince(snap)).toEqual(['src/b.ts']);
  });

  it('includes changes committed after the claim', async () => {
    const reader = new CliGitReader(ws);
    const snap = await reader.snapshot();
    writeFileSync(join(ws, 'src', 'a.ts'), 'committed change\n');
    git('commit', '-qam', 'change');
    expect(await reader.changedSince(snap)).toEqual(['src/a.ts']);
  });
});
