import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubArtifacts } from '@acr/core/artifacts.js';
import { WorkspaceConfig } from '@acr/core/config.js';
import { Hub, type TestRunner } from '@acr/core/hub.js';
import { minimumRisk } from '@acr/core/task/risk.js';
import { estimateJsonTokens } from '@acr/platform/tokens.js';
import type { GitReader, GitSnapshot } from '@acr/core/verify/verify.js';
import { openDatabase } from '@acr/storage/sql.js';
import { HubStore } from '@acr/storage/hub-store.js';

class FakeGit implements GitReader {
  changed: string[] = [];
  async snapshot(): Promise<GitSnapshot> {
    return { head: 'abc123', dirty: {} };
  }
  async changedSince() {
    return [...this.changed];
  }
  async diff(_s: GitSnapshot, paths?: string[]) {
    return (paths ?? this.changed).map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1,2 @@\n-old\n+new\n+more`).join('\n');
  }
}

class FakeTests implements TestRunner {
  passed = 3;
  failed = 0;
  async run() {
    return { exitCode: this.failed ? 1 : 0, output: `Tests: ${this.passed} passed, ${this.failed} failed`, passed: this.passed, failed: this.failed, returned: 'raw' as const, runArtifactId: 'ae_x', runDir: '/tmp/x' };
  }
}

let dir: string;
let root: string;
let git: FakeGit;
let tests: FakeTests;
let hub: Hub;
let clock: number;

const task = (over: Record<string, unknown> = {}) => ({
  title: 'Add health check',
  risk: 'medium',
  goal: 'Add GET /health returning 200.',
  scope: { paths: ['src/server/'] },
  acceptance: ['GET /health returns 200'],
  ...over,
});
const data = <T>(r: { ok: boolean; data?: T; error?: unknown }) => {
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r.error)}`);
  return r.data as T;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acr-hub-'));
  root = join(dir, 'repo');
  mkdirSync(join(root, 'src', 'server'), { recursive: true });
  writeFileSync(join(root, 'src', 'server', 'health.ts'), 'export const ok = 1;\nconst API_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789";\n');
  writeFileSync(join(root, 'src', 'other.ts'), 'x\n');
  writeFileSync(join(root, 'src', 'server', '.env'), 'SECRET=1\n');
  const store = new HubStore(openDatabase(':memory:'));
  clock = Date.parse('2026-09-30T00:00:00Z');
  const now = () => new Date((clock += 1000));
  git = new FakeGit();
  tests = new FakeTests();
  hub = new Hub({
    store,
    artifacts: new HubArtifacts(store, join(dir, 'artifacts'), now),
    config: WorkspaceConfig.parse({ workspace_id: 'demo', name: 'demo' }),
    workspaceRoot: root,
    git,
    tests,
    now,
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('end-to-end flow (SPEC §13)', () => {
  it('create → claim → run tests → submit → verified result → accept', async () => {
    const created = data(await hub.createTask(task()));
    expect(created).toMatchObject({ task: { id: 'T-1', state: 'READY', risk: 'medium' } });

    const claimed = await hub.claimTask();
    expect(data(claimed)).toMatchObject({ task: { id: 'T-1', state: 'CLAIMED' } });
    expect(claimed.next).toMatch(/submit_result/);

    git.changed = ['src/server/health.ts'];
    const run = data<{ artifact: string }>(await hub.runTests('T-1', []));
    const submitted = data<{ verification: { ok: boolean } }>(
      await hub.submitResult('T-1', {
        status: 'completed',
        summary: 'Added /health.',
        changes: [{ path: 'src/server/health.ts', summary: 'new route' }],
        tests: { artifact: run.artifact, passed: 3, failed: 0 },
      }),
    );
    expect(submitted.verification.ok).toBe(true);

    const result = await hub.getResult('T-1');
    const bundle = data<any>(result);
    expect(bundle.verification.tests).toMatchObject({ passed: 3, failed: 0 });
    expect(bundle.diff.stat.files).toEqual([{ path: 'src/server/health.ts', added: 2, removed: 1 }]);
    expect(bundle.acceptance).toEqual({ allowed: true, blockers: [] });
    expect(result.estimatedTokens).toBeGreaterThan(0);

    expect(data(await hub.acceptTask('T-1'))).toMatchObject({ task: { state: 'COMPLETED' } });
    expect(hub.events('T-1').map((e) => e.type)).toEqual([
      'TASK_CREATED',
      'TASK_CLAIMED',
      'RESULT_SUBMITTED',
      'VERIFICATION_COMPLETED',
      'TASK_COMPLETED',
    ]);
  });

  it('flags unclaimed, phantom and out-of-scope changes, and refuses acceptance', async () => {
    await hub.createTask(task());
    await hub.claimTask();
    git.changed = ['src/server/health.ts', 'src/other.ts'];
    const r = data<any>(
      await hub.submitResult('T-1', { status: 'completed', summary: 's', changes: [{ path: 'src/server/health.ts', summary: 'x' }, { path: 'src/server/ghost.ts', summary: 'y' }] }),
    );
    expect(r.verification.findings.map((f: any) => f.code).sort()).toEqual(['claimed_but_unchanged', 'out_of_scope_change', 'unclaimed_change']);
    const accept = await hub.acceptTask('T-1');
    expect(accept.error?.code).toBe('GUARD_FAILED');
    // The developer can override from the CLI; the override is recorded.
    expect(data(await hub.acceptTask('T-1', { force: true, actor: 'human' }))).toMatchObject({ task: { state: 'COMPLETED' } });
    expect(hub.events('T-1').some((e) => e.type === 'GUARD_OVERRIDDEN' && e.actor === 'human')).toBe(true);
  });

  it('catches claimed test counts that disagree with the run_tests artifact', async () => {
    await hub.createTask(task());
    await hub.claimTask();
    tests.failed = 1;
    const run = data<{ artifact: string }>(await hub.runTests('T-1', []));
    git.changed = ['src/server/health.ts'];
    const r = data<any>(
      await hub.submitResult('T-1', { status: 'completed', summary: 's', changes: [{ path: 'src/server/health.ts', summary: 'x' }], tests: { artifact: run.artifact, passed: 4, failed: 0 } }),
    );
    expect(r.verification.findings.map((f: any) => f.code).sort()).toEqual(['test_count_mismatch', 'test_failures']);
  });

  it('marks tests unverified when counts are claimed without an artifact', async () => {
    await hub.createTask(task());
    await hub.claimTask();
    git.changed = ['src/server/health.ts'];
    const r = data<any>(await hub.submitResult('T-1', { status: 'completed', summary: 's', changes: [{ path: 'src/server/health.ts', summary: 'x' }], tests: { passed: 9, failed: 0 } }));
    expect(r.verification.findings).toEqual([expect.objectContaining({ code: 'tests_unverified', blocking: false })]);
  });
});

describe('risk and review policy (SPEC §17)', () => {
  it('raises requested risk from path rules and requires an approving review for high risk', async () => {
    const created = data<any>(await hub.createTask(task({ risk: 'low', scope: { paths: ['src/auth/'] } })));
    expect(created.task).toMatchObject({ risk: 'high', requested_risk: 'low' });
    expect(created.notes[0]).toMatch(/raised from low to high/);

    await hub.claimTask();
    git.changed = ['src/auth/token.ts'];
    await hub.submitResult('T-1', { status: 'completed', summary: 's', changes: [{ path: 'src/auth/token.ts', summary: 'x' }] });
    const accept = await hub.acceptTask('T-1');
    expect(accept.error?.message).toMatch(/approving review/);

    data(await hub.submitReview('T-1', { verdict: 'approve' }));
    expect(data(await hub.acceptTask('T-1'))).toMatchObject({ task: { state: 'COMPLETED' } });
  });

  it('re-evaluates risk on the files actually changed', async () => {
    await hub.createTask(task({ risk: 'low', scope: { paths: ['docs/'] } }));
    await hub.claimTask();
    git.changed = ['docs/a.md', 'src/auth/x.ts'];
    const r = data<any>(await hub.submitResult('T-1', { status: 'completed', summary: 's', changes: [{ path: 'docs/a.md', summary: 'x' }, { path: 'src/auth/x.ts', summary: 'y' }] }));
    expect(r.task.risk).toBe('high');
    expect(r.verification.findings.map((f: any) => f.code)).toContain('risk_raised');
  });

  it('minimumRisk: docs are low, source is medium, auth and destructive constraints are high', () => {
    expect(minimumRisk(['docs/', 'README.md'], [], {}).risk).toBe('low');
    expect(minimumRisk(['src/server/'], [], {}).risk).toBe('medium');
    expect(minimumRisk(['src/auth/'], [], {}).risk).toBe('high');
    expect(minimumRisk(['src/x.ts'], ['Delete the legacy table'], {}).risk).toBe('high');
  });
});

describe('review loop and limits (SPEC §15.3, §18)', () => {
  const submit = async () => {
    git.changed = ['src/server/health.ts'];
    return hub.submitResult('T-1', { status: 'completed', summary: 's', changes: [{ path: 'src/server/health.ts', summary: 'x' }] });
  };

  it('changes_requested → Claude sees the comments → responds → resubmits', async () => {
    await hub.createTask(task());
    await hub.claimTask();
    await submit();
    const review = data<any>(
      await hub.submitReview('T-1', { verdict: 'changes_requested', comments: [{ claim: 'No timeout', reason: 'Health checks must be fast', severity: 'high', evidence: ['src/server/health.ts:1'] }] }),
    );
    expect(review.review.id).toBe('R-1');

    const claimed = data<any>(await hub.claimTask());
    expect(claimed.review_comments).toEqual([expect.objectContaining({ comment_id: 'R-1.1', severity: 'high' })]);

    // High-severity comment blocks acceptance until resolved.
    await submit();
    expect((await hub.acceptTask('T-1')).error?.message).toMatch(/unresolved high-severity/);
    data(await hub.respondReview('R-1', { items: [{ comment_id: 'R-1.1', outcome: 'fixed', evidence: ['src/server/health.ts:1-3'] }] }));
    expect(data(await hub.acceptTask('T-1'))).toMatchObject({ task: { state: 'COMPLETED' } });
  });

  it('rejecting a comment requires evidence', async () => {
    await hub.createTask(task());
    await hub.claimTask();
    await submit();
    await hub.submitReview('T-1', { verdict: 'changes_requested', comments: [{ claim: 'c', reason: 'r', severity: 'low' }] });
    const r = await hub.respondReview('R-1', { items: [{ comment_id: 'R-1.1', outcome: 'rejected' }] });
    expect(r.error?.code).toBe('INVALID_INPUT');
  });

  it('escalates when the review round limit is reached, and the developer resolves it', async () => {
    await hub.createTask(task());
    for (let i = 0; i < 2; i++) {
      await hub.claimTask();
      await submit();
      data(await hub.submitReview('T-1', { verdict: 'changes_requested', comments: [{ claim: 'c', reason: 'r', severity: 'low' }] }));
    }
    await hub.claimTask();
    await submit();
    const third = await hub.submitReview('T-1', { verdict: 'changes_requested', comments: [{ claim: 'c', reason: 'r', severity: 'low' }] });
    expect(third.error?.code).toBe('LIMIT_EXCEEDED');
    expect(data<any>(await hub.getTask('T-1')).task.state).toBe('ESCALATED');
    expect(data<any>(await hub.resolveTask('T-1', 'READY')).task).toMatchObject({ state: 'READY', rounds: { claims: 0, reviews: 0 } });
  });

  it('escalates when Claude exceeds the agent turn limit', async () => {
    hub = new Hub({ ...(hub as any).d, config: WorkspaceConfig.parse({ workspace_id: 'demo', name: 'demo', limits: { max_agent_turns: 1 } }) });
    await hub.createTask(task());
    await hub.claimTask();
    await submit();
    await hub.submitReview('T-1', { verdict: 'changes_requested', comments: [{ claim: 'c', reason: 'r', severity: 'low' }] });
    const again = await hub.claimTask();
    expect(again.error?.code).toBe('LIMIT_EXCEEDED');
  });
});

describe('ChatGPT file access is scoped (SPEC §14.2, §28)', () => {
  beforeEach(async () => {
    await hub.createTask(task());
  });

  it('reads files in scope, redacting secrets', async () => {
    const r = data<any>(await hub.readFile('T-1', { path: 'src/server/health.ts' }));
    expect(r.text).toContain('export const ok = 1;');
    expect(r.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(r.redacted).toBe(true);
  });

  it('refuses files outside scope, deny-listed files, and traversal', async () => {
    expect((await hub.readFile('T-1', { path: 'src/other.ts' })).error?.code).toBe('OUT_OF_SCOPE');
    expect((await hub.readFile('T-1', { path: 'src/server/.env' })).error?.code).toBe('DENIED');
    expect((await hub.readFile('T-1', { path: 'src/server/../../../etc/passwd' })).error?.code).toMatch(/OUT_OF_SCOPE|NOT_FOUND/);
  });

  it('refuses a symlink in scope that points outside the workspace', async () => {
    const outside = join(dir, 'secret.txt');
    writeFileSync(outside, 'top secret\n');
    try {
      symlinkSync(outside, join(root, 'src', 'server', 'link.txt'));
    } catch {
      return; // symlinks need privileges on some Windows setups
    }
    expect((await hub.readFile('T-1', { path: 'src/server/link.txt' })).error?.code).toBe('OUT_OF_SCOPE');
  });
});

describe('context requests and blocking', () => {
  it('ChatGPT asks, Claude answers with a large detail stored as an artifact', async () => {
    await hub.createTask(task());
    await hub.claimTask();
    data(await hub.requestContext('T-1', { question: 'How is routing configured?', paths: ['src/router.ts'] }));
    const bundle = data<any>(await hub.claimTask());
    expect(bundle.context_requests).toEqual([{ id: 'CR-1', question: 'How is routing configured?', paths: ['src/router.ts'] }]);
    const answered = data<any>(await hub.fulfillContext('CR-1', { answer: 'Express router in src/router.ts', details: 'line\n'.repeat(50) }));
    expect(answered.context_request.answer_artifact).toMatch(/^ART-/);
    const art = data<any>(await hub.getArtifact(answered.context_request.answer_artifact, { start: 1, end: 5 }));
    expect(art.total_lines).toBe(50);
  });

  it('report_blocked → decision recorded → Claude picks the task up again', async () => {
    await hub.createTask(task());
    await hub.claimTask();
    data(await hub.reportBlocked('T-1', { reason: 'Two health formats exist', question: 'JSON or plain text?' }));
    expect((await hub.claimTask()).error?.code).toBe('NO_TASK');
    const d = await hub.recordDecision({ task_id: 'T-1', title: 'Use JSON', reason: 'Monitoring expects JSON' });
    expect(d.next).toMatch(/was blocked/);
    const bundle = data<any>(await hub.claimTask());
    expect(bundle.task.id).toBe('T-1');
    expect(bundle.decisions).toEqual([expect.objectContaining({ title: 'Use JSON' })]);
  });
});

describe('secrets never reach ChatGPT through a diff (SPEC §28)', () => {
  it('lists a changed deny-listed file by name only and flags it', async () => {
    await hub.createTask(task());
    await hub.claimTask();
    git.changed = ['src/server/.env', 'src/server/health.ts'];
    const r = data<any>(
      await hub.submitResult('T-1', { status: 'completed', summary: 's', changes: [{ path: 'src/server/.env', summary: 'x' }, { path: 'src/server/health.ts', summary: 'y' }] }),
    );
    expect(r.verification.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'secret_file_changed', paths: ['src/server/.env'], blocking: false }),
        expect.objectContaining({ code: 'risk_raised' }), // touching .env also makes the task high risk
      ]),
    );
    const diff = data<any>(await hub.getDiff('T-1'));
    expect(diff.text).toContain('content withheld: src/server/.env');
    expect(diff.text).not.toMatch(/diff --git a\/src\/server\/\.env b\/src\/server\/\.env\n---/);
  });
});

describe('metrics (SPEC §29)', () => {
  it('attributes the reply after the last ACR call and reports a token breakdown', async () => {
    const u = (id: string, ts: string, read: number) => ({
      type: 'usage', timestamp: ts, stream_id: 'm',
      usage: { request_id: id, input_uncached: 2, input_cache_read: read, input_cache_write: 10, output_total: 5, scope: 'request', origin: 'provider_reported' },
    });
    const reader = {
      read: async () => ({
        events: [
          u('before', '2026-09-30T00:00:00.000Z', 1), // long before the task: excluded
          u('claim', '2026-09-30T01:00:00.000Z', 100),
          u('work', '2026-09-30T01:05:00.000Z', 200),
          u('reply', '2026-09-30T01:10:30.000Z', 300), // reply to the last ACR tool result: included
          u('later', '2026-09-30T02:00:00.000Z', 400), // unrelated later work: excluded
        ] as any,
        gaps: [],
      }),
    };
    const store = (hub as any).d.store;
    hub = new Hub({ ...(hub as any).d, transcripts: reader });
    await hub.createTask(task());
    store.insertSession({ session_id: 's', task_id: 'T-1', transcript_path: '/x', tool: 'get_task', timestamp: '2026-09-30T01:00:30.000Z' });
    store.insertSession({ session_id: 's', task_id: 'T-1', transcript_path: '/x', tool: 'submit_result', timestamp: '2026-09-30T01:10:00.000Z' });
    const m = data<any>(await hub.getMetrics('T-1'));
    expect(m.claude.requests).toBe(3);
    expect(m.claude.breakdown).toEqual({ input_uncached: 6, input_cache_read: 600, input_cache_write: 30, output: 15 });
    expect(m.claude.tokens).toBe(651);
  });

  it('estimates ChatGPT tool I/O cumulatively and never mixes it with measured tokens', async () => {
    const r1 = await hub.createTask(task());
    hub.recordToolCall('remote', 'create_task', 'T-1', task(), r1);
    const r2 = await hub.getTask('T-1');
    hub.recordToolCall('remote', 'get_task', 'T-1', { task_id: 'T-1' }, r2);
    const m = data<any>(await hub.getMetrics('T-1'));
    const call1 = estimateJsonTokens(task()) + r1.estimatedTokens;
    const call2 = estimateJsonTokens({ task_id: 'T-1' }) + r2.estimatedTokens;
    expect(m.chatgpt).toMatchObject({ kind: 'estimated', bound: 'lower', tool_calls: 2, tool_io_once: call1 + call2 });
    // The first call stays in the conversation for the second turn too.
    expect(m.chatgpt.tool_io_cumulative).toBe(call1 * 2 + call2);
    expect(m.claude).toMatchObject({ kind: 'measured', completeness: 'no_session', tokens: null });
  });
});
