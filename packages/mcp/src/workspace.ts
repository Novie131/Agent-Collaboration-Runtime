import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { HubArtifacts } from '@acr/core/artifacts.js';
import { WorkspaceConfig } from '@acr/core/config.js';
import { Hub, type TestRunner } from '@acr/core/hub.js';
import { claudeTranscriptReader } from '@acr/core/metrics/metrics.js';
import { CliGitReader } from '@acr/git/git-reader.js';
import { projectDataDirectory } from '@acr/platform/app-data.js';
import { HubStore } from '@acr/storage/hub-store.js';
import { openDatabase } from '@acr/storage/sql.js';
import { JestTestRunner } from './test-runner.js';

export const CONFIG_DIR = '.agent-runtime';
export const CONFIG_FILE = 'config.json';

/** Walks up from `start` to the directory containing `.agent-runtime/config.json`. */
export function findWorkspaceRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_DIR, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(root: string): WorkspaceConfig {
  const file = join(root, CONFIG_DIR, CONFIG_FILE);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const parsed = WorkspaceConfig.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';

/** `acr init`: writes `.agent-runtime/config.json` (+ .gitignore) and the project's local token. */
export function initWorkspace(root: string, opts: { name?: string; id?: string } = {}) {
  const dir = join(root, CONFIG_DIR);
  const file = join(dir, CONFIG_FILE);
  if (existsSync(file)) return { created: false, config: loadConfig(root), file };
  const name = opts.name ?? basename(resolve(root));
  const id = opts.id ?? `${slug(name)}-${randomBytes(3).toString('hex')}`;
  const config = WorkspaceConfig.parse({ workspace_id: id, name });
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, workspace_id: id, name }, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(join(dir, '.gitignore'), '*\n!config.json\n!.gitignore\n', { flag: 'w' });
  return { created: true, config, file };
}

export function dataDir(config: WorkspaceConfig) {
  const d = projectDataDirectory(config.workspace_id);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** Bearer token for the local endpoint, kept in the project data dir (never in the repo). */
export function localToken(config: WorkspaceConfig): string {
  const file = join(dataDir(config), 'local-token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
  return token;
}

export type OpenedWorkspace = { root: string; config: WorkspaceConfig; hub: Hub; store: HubStore; close(): void };

/** Opens the hub for a workspace. `withRunner: false` for CLI commands that never run tests. */
export function openWorkspace(root: string, opts: { withGit?: boolean; tests?: TestRunner | null } = {}): OpenedWorkspace {
  const config = loadConfig(root);
  const dir = dataDir(config);
  const dbFile = join(dir, 'hub.sqlite');
  const db = openDatabase(dbFile);
  // SQLite creates files with the process umask (often world-readable); the DB holds task text and paths.
  if (process.platform !== 'win32') {
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  }
  const store = new HubStore(db);
  const hub = new Hub({
    store,
    artifacts: new HubArtifacts(store, join(dir, 'artifacts')),
    config,
    workspaceRoot: root,
    git: opts.withGit === false ? null : new CliGitReader(root),
    tests: opts.tests === undefined ? new JestTestRunner(root, join(dir, 'runs'), config.runner) : opts.tests,
    transcripts: claudeTranscriptReader,
  });
  return { root, config, hub, store, close: () => db.close() };
}
