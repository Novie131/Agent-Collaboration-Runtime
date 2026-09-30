import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '@acr/transcripts/claude-code.js';
import { summarizeUsage } from '@acr/transcripts/usage.js';
import type { UsageEvent } from '@acr/protocol/transcript-events.js';

/**
 * De-identified structure of a real Claude Code 2.1.283 (VS Code extension) session,
 * produced by scripts/deidentify-claude-transcript.mjs. Text bodies are hashes.
 */
const FIXTURE = fileURLToPath(new URL('../fixtures/real/claude-code-2.1.283/session.deidentified.jsonl', import.meta.url));

describe.skipIf(!existsSync(FIXTURE))('claude-code adapter on a real (de-identified) 2.1.283 transcript', () => {
  it('parses in strict mode without skipped lines', async () => {
    const r = await claudeCodeAdapter.parse(FIXTURE, { strict: true, maxLineBytes: 8 << 20, inputId: 'fixture' });
    expect(r.coverage.skipped).toEqual([]);
    expect(r.coverage.parsed_lines).toBeGreaterThan(100);
  });

  it('pairs every tool_result with a tool_use by id', async () => {
    const r = await claudeCodeAdapter.parse(FIXTURE, { strict: true, maxLineBytes: 8 << 20, inputId: 'fixture' });
    const calls = new Set(r.events.filter((e) => e.type === 'tool_call').map((e) => (e.type === 'tool_call' ? e.tool_call_id : '')));
    const results = r.events.filter((e) => e.type === 'tool_result');
    expect(results.length).toBeGreaterThan(10);
    for (const res of results) if (res.type === 'tool_result') expect(calls.has(res.tool_call_id)).toBe(true);
    expect(r.warnings.filter((w) => w.includes('without a matching tool_use'))).toEqual([]);
  });

  it('has complete per-request usage but reports the whole task as incomplete (unobserved host calls)', async () => {
    const r = await claudeCodeAdapter.parse(FIXTURE, { strict: true, maxLineBytes: 8 << 20, inputId: 'fixture' });
    const usage = r.events.filter((e): e is UsageEvent => e.type === 'usage');
    expect(usage.length).toBeGreaterThan(20);
    expect(usage.every((u) => u.usage.completeness === 'complete')).toBe(true);
    expect(r.unobservedRequests).toEqual(
      expect.arrayContaining(['session title generation call(s) (ai-title entries)', 'permission-classifier call(s) (serverClassifierRequest)']),
    );
    const s = summarizeUsage(usage, [], (r.unobservedRequests ?? []).length > 0);
    expect(s.completeness).toBe('incomplete');
    expect(s.t_task).toBeNull();
    expect(s.observed_totals.input_cache_read).toBeGreaterThan(0);
  });
});
