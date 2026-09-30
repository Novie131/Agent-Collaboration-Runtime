import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { OpenedWorkspace } from '@acr/mcp/workspace.js';
import { dataDir } from '@acr/mcp/workspace.js';
import { findEnvFiles } from '@acr/security/privacy.js';

export type Check = { status: 'ok' | 'warn' | 'fail' | 'fixed' | 'skip'; title: string; detail?: string };

const run = (cmd: string, args: string[], cwd?: string) =>
  spawnSync(cmd, args, { cwd, shell: false, encoding: 'utf8', timeout: 10_000, windowsHide: true });

/** Owner-only permissions on the hub's data (DB, artifacts with unredacted output, local token). */
function checkPermissions(dir: string, fix: boolean): Check[] {
  if (process.platform === 'win32') return [{ status: 'skip', title: 'Data directory permissions', detail: 'Windows ACLs are not checked; the directory is under your user profile.' }];
  const out: Check[] = [];
  const targets: { path: string; mode: number }[] = [{ path: dir, mode: 0o700 }];
  for (const name of ['local-token', 'hub.sqlite', 'hub.sqlite-wal', 'hub.sqlite-shm']) targets.push({ path: join(dir, name), mode: 0o600 });
  for (const sub of ['artifacts', 'runs']) targets.push({ path: join(dir, sub), mode: 0o700 });
  let fixed = 0;
  let bad = 0;
  for (const t of targets) {
    if (!existsSync(t.path)) continue;
    const mode = statSync(t.path).mode & 0o777;
    if (mode & 0o077) {
      if (fix) {
        chmodSync(t.path, t.mode);
        fixed++;
      } else bad++;
    }
  }
  if (fixed) out.push({ status: 'fixed', title: 'Data directory permissions', detail: `tightened ${fixed} path(s) to owner-only` });
  else if (bad) out.push({ status: 'fail', title: 'Data directory permissions', detail: `${bad} path(s) readable by other users; run \`acr doctor --fix\`` });
  else out.push({ status: 'ok', title: 'Data directory permissions', detail: 'owner-only' });
  return out;
}

function checkDiskEncryption(): Check {
  if (process.platform === 'darwin') {
    const r = run('fdesetup', ['status']);
    if (r.status !== 0) return { status: 'skip', title: 'Disk encryption (FileVault)', detail: 'could not run fdesetup' };
    return /FileVault is On/.test(r.stdout)
      ? { status: 'ok', title: 'Disk encryption (FileVault)', detail: 'on' }
      : { status: 'warn', title: 'Disk encryption (FileVault)', detail: 'off: hub data and ~/.claude.json (local token) are unencrypted at rest. System Settings → Privacy & Security → FileVault.' };
  }
  return { status: 'skip', title: 'Disk encryption', detail: process.platform === 'win32' ? 'BitLocker needs admin rights to query; check it in Settings → Privacy & security → Device encryption.' : 'not checked on Linux (LUKS).' };
}

function checkOtherUsers(): Check {
  if (process.platform !== 'darwin') return { status: 'skip', title: 'Other user accounts' };
  const r = run('dscl', ['.', 'list', '/Users', 'UniqueID']);
  if (r.status !== 0) return { status: 'skip', title: 'Other user accounts' };
  const humans = r.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([name, id]) => name && !name.startsWith('_') && Number(id) >= 501);
  return humans.length > 1
    ? { status: 'warn', title: 'Other user accounts', detail: `${humans.length} login accounts on this Mac; the remote endpoint (8787) has no token, so other local users could call ChatGPT-side tools while the hub runs.` }
    : { status: 'ok', title: 'Other user accounts', detail: 'single user' };
}

/** .env files must never be committed, since they would then be in git history and possibly pushed. */
function checkEnvFiles(root: string): Check[] {
  const files = findEnvFiles(root).map((f) => relative(root, f).split(sep).join('/'));
  if (!files.length) return [{ status: 'ok', title: '.env files', detail: 'none found' }];
  const isRepo = run('git', ['rev-parse', '--is-inside-work-tree'], root).status === 0;
  if (!isRepo) return [{ status: 'warn', title: '.env files', detail: `${files.length} found; not a git repository, so ignore rules were not checked` }];
  const out: Check[] = [];
  for (const f of files) {
    const tracked = run('git', ['ls-files', '--error-unmatch', '--', f], root).status === 0;
    const ignored = run('git', ['check-ignore', '-q', '--', f], root).status === 0;
    if (tracked) out.push({ status: 'fail', title: `.env: ${f}`, detail: 'tracked by git; remove it from the index (git rm --cached) and rotate its secrets if it was ever pushed' });
    else if (!ignored) out.push({ status: 'warn', title: `.env: ${f}`, detail: 'not in .gitignore; one `git add -A` would commit it' });
  }
  if (!out.length) out.push({ status: 'ok', title: '.env files', detail: `${files.length} found, all git-ignored` });
  return out;
}

/** The local bearer token belongs in user-level config, never in a file inside the repository. */
function checkTokenNotInRepo(root: string, token: string | null): Check {
  if (!token) return { status: 'skip', title: 'Local token not in repository' };
  const candidates = ['.mcp.json', join('.claude', 'settings.json'), join('.claude', 'settings.local.json'), join('.vscode', 'settings.json'), join('.vscode', 'mcp.json')];
  const hits = candidates.filter((c) => existsSync(join(root, c)) && readFileSync(join(root, c), 'utf8').includes(token));
  return hits.length
    ? { status: 'fail', title: 'Local token not in repository', detail: `found in ${hits.join(', ')}; remove it and register with \`claude mcp add --scope user\` instead` }
    : { status: 'ok', title: 'Local token not in repository' };
}

function checkPrivacyGuard(ws: OpenedWorkspace): Check {
  const p = ws.config.privacy;
  const keys = ws.hub.privacy.protectedKeys();
  const byFile = new Map<string, string[]>();
  for (const k of keys) byFile.set(k.file, [...(byFile.get(k.file) ?? []), k.key]);
  const list = [...byFile].map(([f, ks]) => `${f}: ${ks.join(', ')}`).join('; ');
  if (!p.env_files) return { status: 'warn', title: 'Outgoing privacy guard', detail: 'env_files is off: .env values are not masked for ChatGPT' };
  return {
    status: 'ok',
    title: 'Outgoing privacy guard',
    detail: `masks ${keys.length} .env value(s)${list ? ` (${list})` : ''}; personal data: ${p.pii.join(', ') || 'off'}; blocks at ${p.block_env_threshold}+ .env entries`,
  };
}

export function runDoctor(ws: OpenedWorkspace, opts: { fix: boolean }): Check[] {
  const dir = dataDir(ws.config);
  const tokenFile = join(dir, 'local-token');
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : null;
  return [
    checkPrivacyGuard(ws),
    ...checkEnvFiles(ws.root),
    checkTokenNotInRepo(ws.root, token),
    ...checkPermissions(dir, opts.fix),
    checkDiskEncryption(),
    checkOtherUsers(),
  ];
}

const ICON: Record<Check['status'], string> = { ok: '✓', fixed: '✓', warn: '!', fail: '✗', skip: '·' };
export const formatChecks = (checks: Check[]) =>
  checks.map((c) => `  ${ICON[c.status]} ${c.title}${c.status === 'fixed' ? ' (fixed)' : ''}${c.detail ? ` — ${c.detail}` : ''}`).join('\n');
