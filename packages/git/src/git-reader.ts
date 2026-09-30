import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitReader, GitSnapshot } from '@acr/core/verify/verify.js';

/** Runs git with an argv array (no shell) and returns stdout; rejects on non-zero exit. */
function git(cwd: string, args: string[], executable = 'git'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}`));
    });
  });
}

const splitZ = (s: string) => s.split('\0').filter(Boolean);

/** Content hash of a working-tree file; null when it does not exist. */
async function fileHash(root: string, rel: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(join(root, rel))).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Read-only git access for result verification (SPEC §21). Never writes to the repository:
 * no index refresh, no stash, no checkout.
 */
export class CliGitReader implements GitReader {
  constructor(
    private readonly root: string,
    private readonly executable = 'git',
  ) {}

  private run(args: string[]) {
    return git(this.root, args, this.executable);
  }

  private async head(): Promise<string | null> {
    try {
      return (await this.run(['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null;
    } catch {
      return null;
    }
  }

  /** Paths that differ from `base` in the working tree, plus untracked files. */
  private async touched(base: string | null): Promise<string[]> {
    const tracked = base
      ? splitZ(await this.run(['diff', '--relative', '--name-only', '-z', '--no-renames', base, '--']))
      : splitZ(await this.run(['ls-files', '-z']));
    const untracked = splitZ(await this.run(['ls-files', '-z', '--others', '--exclude-standard']));
    return [...new Set([...tracked, ...untracked])].sort();
  }

  async snapshot(): Promise<GitSnapshot> {
    const head = await this.head();
    const dirty: Record<string, string | null> = {};
    for (const p of await this.touched(head)) dirty[p] = await fileHash(this.root, p);
    return { head, dirty };
  }

  async changedSince(s: GitSnapshot): Promise<string[]> {
    const out: string[] = [];
    const now = await this.touched(s.head);
    for (const p of now) {
      if (p in s.dirty) {
        if ((await fileHash(this.root, p)) !== s.dirty[p]) out.push(p);
      } else out.push(p);
    }
    // Files dirty at claim time that were reverted back to HEAD also changed.
    for (const p of Object.keys(s.dirty)) {
      if (!now.includes(p)) out.push(p);
    }
    return [...new Set(out)].sort();
  }

  async diff(s: GitSnapshot, paths?: string[]): Promise<string> {
    const files = paths ?? (await this.changedSince(s));
    if (!files.length) return '';
    const untracked = new Set(splitZ(await this.run(['ls-files', '-z', '--others', '--exclude-standard'])));
    const trackedFiles = files.filter((f) => !untracked.has(f));
    const parts: string[] = [];
    if (trackedFiles.length && s.head) {
      parts.push(await this.run(['diff', '--relative', '--no-color', '--no-ext-diff', '--no-renames', s.head, '--', ...trackedFiles]));
    }
    for (const f of files.filter((f) => untracked.has(f))) {
      const content = await readFile(join(this.root, f), 'utf8').catch(() => null);
      if (content === null) continue;
      const lines = content.split('\n');
      if (content.endsWith('\n')) lines.pop();
      parts.push([`diff --git a/${f} b/${f}`, 'new file (untracked)', '--- /dev/null', `+++ b/${f}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n') + '\n');
    }
    const note = files.some((f) => f in s.dirty)
      ? `# note: ${files.filter((f) => f in s.dirty).length} file(s) were already modified before the claim; their diff includes those earlier edits\n`
      : '';
    return note + parts.join('');
  }
}
