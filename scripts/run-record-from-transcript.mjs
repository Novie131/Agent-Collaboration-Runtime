#!/usr/bin/env node
// Builds a RunRecord (see src/schema/evaluation.ts) for `agent-efficiency compare`
// from one Claude Code transcript plus a verifier result written by an EXTERNAL
// verifier. Requires `pnpm build`. Nothing is executed from the transcript.
//
// node scripts/run-record-from-transcript.mjs <transcript.jsonl> \
//   --run-id fix-sum-B-1 --task fix-sum --group B --rep 1 \
//   --settings settings.json --verifier verifier-result.json [--policy jest-v1 --policy-hash sha256:...] \
//   [--cache-state cold] [--timed-out] > run.json
import { readFileSync } from 'node:fs';
import { claudeCodeAdapter } from '../dist/adapters/claude-code.js';
import { RunRecord } from '../dist/schema/evaluation.js';

const [, , transcript, ...rest] = process.argv;
const opt = (n) => {
  const i = rest.indexOf(n);
  return i === -1 ? undefined : rest[i + 1];
};
const need = (n) => {
  const v = opt(n);
  if (v === undefined) {
    console.error(`missing ${n}`);
    process.exit(2);
  }
  return v;
};
if (!transcript) {
  console.error('usage: run-record-from-transcript.mjs <transcript.jsonl> --run-id … --task … --group A0|A1|B --rep N --settings f --verifier f');
  process.exit(2);
}

const parsed = await claudeCodeAdapter.parse(transcript, { strict: false, maxLineBytes: 8 << 20, inputId: 'transcript' });
const usage = parsed.events.filter((e) => e.type === 'usage').map((e) => e.usage);
const calls = parsed.events.filter((e) => e.type === 'tool_call');
const cmd = (e) => (typeof e.args?.command === 'string' ? e.args.command : '');
const gaps = [
  ...(parsed.unobservedRequests ?? []).map((u) => `not in transcript: ${u}`),
  ...(parsed.coverage.partial ? [`transcript partially parsed (${parsed.coverage.skipped.length} lines skipped)`] : []),
];
const outputBytes = parsed.events.filter((e) => e.type === 'tool_result').reduce((n, e) => n + (e.output_bytes ?? 0), 0);
const times = parsed.events.map((e) => e.timestamp).filter(Boolean).sort();
const policy = opt('--policy');

const record = {
  run_id: need('--run-id'),
  task_id: need('--task'),
  group: need('--group'),
  repetition: Number(need('--rep')),
  settings: JSON.parse(readFileSync(need('--settings'), 'utf8')),
  policy: policy ? { id: policy, hash: need('--policy-hash') } : null,
  cache_state: opt('--cache-state') ?? 'unknown',
  started_at: times[0] ?? new Date(0).toISOString(),
  ...(times.length ? { ended_at: times[times.length - 1] } : {}),
  timed_out: rest.includes('--timed-out'),
  verifier: JSON.parse(readFileSync(need('--verifier'), 'utf8')),
  usage: { requests: usage, ...(gaps.length ? { gaps } : {}) },
  tool_output_bytes: outputBytes,
  ...(times.length > 1 ? { duration_ms: Date.parse(times[times.length - 1]) - Date.parse(times[0]) } : {}),
  adoption: {
    wrapper_invocations: calls.filter((c) => /\bagent-efficiency\s+test\b/.test(cmd(c))).length,
    expand_invocations: calls.filter((c) => /\bagent-efficiency\s+expand\b/.test(cmd(c))).length,
  },
};
const checked = RunRecord.safeParse(record);
if (!checked.success) {
  console.error(checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(checked.data, null, 2)}\n`);
if (gaps.length) console.error(`note: usage is incomplete for this run (${gaps.join('; ')}); compare will report tokens as inconclusive.`);
