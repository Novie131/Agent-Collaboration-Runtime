import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '@acr/transcripts/claude-code.js';
import { InvalidInputError } from '@acr/transcripts/types.js';
import { runRules } from '@acr/telemetry/rules.js';
import { summarizeUsage } from '@acr/transcripts/usage.js';
import type { UsageEvent } from '@acr/protocol/transcript-events.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/synthetic/claude-code/session.jsonl', import.meta.url));
const opts = { strict: false, maxLineBytes: 1 << 20, inputId: 'session.jsonl' };

describe('claude-code adapter (experimental, synthetic fixture)', () => {
  it('pairs tool_use with tool_result by id and maps categories', async () => {
    const { events } = await claudeCodeAdapter.parse(FIXTURE, opts);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.map((r) => (r.type === 'tool_result' ? [r.tool_call_id, r.category] : null))).toEqual([
      ['toolu_1', 'read'],
      ['toolu_2', 'read'],
      ['toolu_3', 'read'],
      ['toolu_4', 'shell'],
      ['toolu_5', 'edit'],
      ['toolu_6', 'search'],
    ]);
    const bash = results.find((r) => r.type === 'tool_result' && r.tool_call_id === 'toolu_4');
    expect(bash).toMatchObject({ exit_code: 127, error_kind: 'command_not_found' });
    expect(events.some((e) => e.type === 'file_change' && e.path === '/work/proj/src/sum.ts')).toBe(true);
  });

  it('deduplicates usage by request id and uses the largest output count', async () => {
    const { events } = await claudeCodeAdapter.parse(FIXTURE, opts);
    const usage = events.filter((e): e is UsageEvent => e.type === 'usage');
    expect(usage).toHaveLength(7);
    const req1 = usage.find((u) => u.usage.request_id === 'req_1')!.usage;
    expect(req1).toMatchObject({ input_uncached: 10, input_cache_write: 2000, input_cache_read: 0, output_total: 40, completeness: 'complete' });
    const req7 = usage.find((u) => u.usage.request_id === 'req_7')!.usage;
    expect(req7).toMatchObject({ completeness: 'incomplete', missing_fields: ['input_cache_write'] });
    const s = summarizeUsage(usage);
    expect(s.completeness).toBe('incomplete');
    expect(s.t_task).toBeNull();
  });

  it('puts sidechain entries in their own stream and advances the epoch on compaction', async () => {
    const { events, warnings } = await claudeCodeAdapter.parse(FIXTURE, opts);
    const grep = events.find((e) => e.type === 'tool_call' && e.tool_call_id === 'toolu_6')!;
    expect(grep.stream_id).toBe('sidechain:agent_a');
    const boundary = events.find((e) => e.type === 'context_boundary');
    expect(boundary).toMatchObject({ kind: 'compaction', next_epoch: 'e1' });
    expect(warnings.join(' ')).toMatch(/Compaction/);
  });

  it('finds the triple read of the same content (R001)', async () => {
    const { events } = await claudeCodeAdapter.parse(FIXTURE, opts);
    const out = runRules(events, undefined, '/work/proj');
    const r001 = out.findings.filter((f) => f.rule === 'R001');
    expect(r001).toHaveLength(1);
    expect(r001[0]!.subject).toBe('src/sum.ts');
  });

  it('links legacy agent-efficiency test output to its artifact and detects expansion (R004, adoption)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ae-cc-'));
    const p = join(dir, 's.jsonl');
    const id = 'ae_20260101000000_abcdef12';
    const entry = (o: object) => JSON.stringify({ sessionId: 'S', isSidechain: false, ...o });
    const use = (tid: string, command: string, req: string) =>
      entry({ type: 'assistant', uuid: `a${tid}`, requestId: req, message: { id: req, role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'Bash', input: { command } }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } });
    const result = (tid: string, content: string) => entry({ type: 'user', uuid: `u${tid}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content }] } });
    await writeFile(
      p,
      [
        use('t1', 'npx agent-efficiency test --mode optimize --policy jest-v1 --allow-experimental --run-dir r1 -- src', 'q1'),
        result('t1', `[agent-efficiency jest-v1 (experimental) · selective view, not lossless · artifact ${id}]\nSuites: 1 failed`),
        use('t2', `npx agent-efficiency expand ${id} --run-dir r1 --part passed`, 'q2'),
        result('t2', 'passed names'),
      ].join('\n'),
    );
    const { events } = await claudeCodeAdapter.parse(p, opts);
    expect(events.find((e) => e.type === 'tool_result' && e.tool_call_id === 't1')).toMatchObject({ artifact_id: id, policy_id: 'jest-v1' });
    expect(events.find((e) => e.type === 'tool_call' && e.tool_call_id === 't2')).toMatchObject({ expanded_from_artifact_id: id });
    const r004 = runRules(events).findings.filter((f) => f.rule === 'R004');
    expect(r004).toHaveLength(1);
    expect(r004[0]!.causality).toBe('unproven');
  });

  it('ignores non-message entries and rejects files with no transcript entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ae-cc-'));
    const p = join(dir, 'x.jsonl');
    await writeFile(p, '{"foo":1}\n');
    await expect(claudeCodeAdapter.parse(p, opts)).rejects.toThrow(InvalidInputError);
  });
});
