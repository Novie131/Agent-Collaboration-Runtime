import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestRunner } from '@acr/core/hub.js';
import { startHubServers, type RunningHub } from '@acr/mcp/server.js';
import { initWorkspace, openWorkspace, type OpenedWorkspace } from '@acr/mcp/workspace.js';

const TOKEN = 'test-token-0123456789';
const hasGit = spawnSync('git', ['--version'], { shell: false }).status === 0;

let dir: string;
let repo: string;
let ws: OpenedWorkspace;
let hub: RunningHub;
let remote: Client;
let local: Client;
const oldHome = process.env.ACR_HOME;

const git = (...args: string[]) => {
  const r = spawnSync('git', args, { cwd: repo, shell: false, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
};

class FixedTests implements TestRunner {
  async run() {
    return { exitCode: 0, output: 'Tests: 2 passed', passed: 2, failed: 0, returned: 'raw' as const, runArtifactId: null, runDir: '' };
  }
}

async function connect(url: string, token?: string) {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined),
  );
  return client;
}

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return JSON.parse(r.content[0]!.text) as { ok: boolean; data?: any; error?: { code: string; message: string }; next?: string };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'acr-mcp-'));
  process.env.ACR_HOME = join(dir, 'home');
  repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src', 'server'), { recursive: true });
  writeFileSync(join(repo, 'src', 'server', 'app.ts'), 'export const app = 1;\n');
  writeFileSync(join(repo, 'notes.txt'), 'pre-existing edit\n');
  if (hasGit) {
    git('init', '-q');
    git('-c', 'user.email=t@e.st', '-c', 'user.name=t', 'add', '.');
    git('-c', 'user.email=t@e.st', '-c', 'user.name=t', 'commit', '-qm', 'init');
  }
  // Dirty before the claim: must not be attributed to Claude.
  writeFileSync(join(repo, 'notes.txt'), 'pre-existing edit, changed before claim\n');
  initWorkspace(repo, { name: 'demo', id: 'demo' });
  ws = openWorkspace(repo, { tests: new FixedTests() });
  hub = await startHubServers({ hub: ws.hub, name: 'acr', ports: { remote: 0, local: 0 }, localToken: TOKEN, log: () => {} });
  remote = await connect(hub.remoteUrl);
  local = await connect(hub.localUrl, TOKEN);
});

afterAll(async () => {
  await remote?.close();
  await local?.close();
  await hub?.close();
  ws?.close();
  if (oldHome === undefined) delete process.env.ACR_HOME;
  else process.env.ACR_HOME = oldHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('endpoint separation (ADR-0004)', () => {
  it('the remote endpoint exposes only ChatGPT tools, with read tools marked read-only', async () => {
    const { tools } = await remote.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['accept_task', 'cancel_task', 'create_task', 'get_artifact', 'get_decisions', 'get_diff', 'get_metrics', 'get_result', 'get_task', 'list_tasks', 'read_file', 'record_decision', 'request_context', 'submit_review'].sort(),
    );
    for (const forbidden of ['submit_result', 'run_tests', 'respond_review', 'fulfill_context', 'report_blocked', 'expand']) {
      expect(names).not.toContain(forbidden);
    }
    const ro = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint === true]));
    expect(ro).toMatchObject({ get_result: true, get_diff: true, read_file: true, get_artifact: true, list_tasks: true, create_task: false, accept_task: false, submit_review: false });
  });

  it('the local endpoint requires the bearer token', async () => {
    await expect(connect(hub.localUrl)).rejects.toThrow();
    await expect(connect(hub.localUrl, 'wrong-token-0123456789')).rejects.toThrow();
  });

  it('the local endpoint rejects foreign Host headers (DNS rebinding)', async () => {
    // fetch() silently drops a custom Host header, so use node:http directly.
    const post = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(hub.localUrl);
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const req = request(
          { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { host, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    expect(await post('evil.example')).toBeGreaterThanOrEqual(400);
    expect(await post(new URL(hub.localUrl).host)).toBe(200);
  });
});

describe('remote endpoint hardening (SPEC §28)', () => {
  it('rejects foreign Host headers on the remote endpoint too', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(hub.remoteUrl);
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const req = request(
        { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { host: 'attacker.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('redacts secrets anywhere in a remote response, not only in file reads', async () => {
    const created = await call(remote, 'create_task', {
      title: 'Rotate key',
      risk: 'low',
      goal: 'Replace the key sk-ant-abcdefghijklmnopqrstuvwxyz123456 in docs',
      scope: { paths: ['docs/'] },
      acceptance: ['done'],
    });
    expect(JSON.stringify(created)).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz');
    expect(created.data.task.goal).toContain('[REDACTED:api_key]');
    await call(remote, 'cancel_task', { task_id: created.data.task.id });
  });
});

describe.skipIf(!hasGit)('full flow over MCP with real git', () => {
  it('ChatGPT creates → Claude claims, edits, tests, submits → hub verifies → ChatGPT reviews and accepts', async () => {
    const created = await call(remote, 'create_task', {
      title: 'Add health endpoint',
      risk: 'medium',
      goal: 'GET /health returns ok',
      scope: { paths: ['src/server/'] },
      acceptance: ['returns ok'],
    });
    expect(created.ok).toBe(true);
    const id = created.data.task.id as string;
    expect(created.next).toMatch(/Claude Code/);

    const claimed = await call(local, 'get_task', {});
    expect(claimed.data.task).toMatchObject({ id, state: 'CLAIMED' });

    writeFileSync(join(repo, 'src', 'server', 'health.ts'), 'export const health = () => "ok";\n');
    writeFileSync(join(repo, 'src', 'server', 'app.ts'), 'export const app = 1;\nexport * from "./health";\n');
    const tests = await call(local, 'run_tests', { task_id: id });
    expect(tests.data).toMatchObject({ passed: 2, failed: 0 });

    const submitted = await call(local, 'submit_result', {
      task_id: id,
      status: 'completed',
      summary: 'Added /health',
      changes: [
        { path: 'src/server/health.ts', summary: 'new' },
        { path: 'src/server/app.ts', summary: 'export' },
      ],
      tests: { artifact: tests.data.artifact, passed: 2, failed: 0 },
    });
    expect(submitted.data.verification).toMatchObject({ ok: true, changed_files: ['src/server/app.ts', 'src/server/health.ts'] });

    const result = await call(remote, 'get_result', { task_id: id });
    expect(result.data.verification.ok).toBe(true);
    expect(result.data.diff.stat.files.map((f: any) => f.path).sort()).toEqual(['src/server/app.ts', 'src/server/health.ts']);

    const diff = await call(remote, 'get_diff', { task_id: id, path: 'src/server/health.ts' });
    expect(diff.data.text).toContain('+export const health');

    expect((await call(remote, 'read_file', { task_id: id, path: 'notes.txt' })).error?.code).toBe('OUT_OF_SCOPE');

    const accepted = await call(remote, 'accept_task', { task_id: id });
    expect(accepted.data.task.state).toBe('COMPLETED');

    const metrics = await call(remote, 'get_metrics', { task_id: id });
    expect(metrics.data.chatgpt).toMatchObject({ kind: 'estimated', tool_calls: 5 });
    expect(metrics.data.diagnostics.local_tool_calls).toBe(3);
  });
});
