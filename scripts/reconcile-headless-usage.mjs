#!/usr/bin/env node
// Compares the usage reported by `claude -p --output-format json` with the per-request
// usage found in the same session's transcript, to see which model calls the transcript
// misses. Prints numbers only. Requires `pnpm build`.
// node scripts/reconcile-headless-usage.mjs <result.json> <transcript.jsonl>
import { readFileSync } from 'node:fs';
import { claudeCodeAdapter } from '../dist/adapters/claude-code.js';

const [, , resultPath, transcriptPath] = process.argv;
if (!resultPath || !transcriptPath) {
  console.error('usage: reconcile-headless-usage.mjs <result.json> <transcript.jsonl>');
  process.exit(2);
}
const result = JSON.parse(readFileSync(resultPath, 'utf8'));
const parsed = await claudeCodeAdapter.parse(transcriptPath, { strict: false, maxLineBytes: 8 << 20, inputId: 'transcript' });
const reqs = parsed.events.filter((e) => e.type === 'usage').map((e) => e.usage);

const sum = (f) => reqs.reduce((n, u) => n + (u[f] ?? 0), 0);
const transcript = {
  requests: reqs.length,
  incomplete_requests: reqs.filter((u) => u.completeness === 'incomplete').length,
  input_uncached: sum('input_uncached'),
  input_cache_read: sum('input_cache_read'),
  input_cache_write: sum('input_cache_write'),
  output_total: sum('output_total'),
};

const u = result.usage ?? {};
const headlessTop = {
  input_uncached: u.input_tokens,
  input_cache_read: u.cache_read_input_tokens,
  input_cache_write: u.cache_creation_input_tokens,
  output_total: u.output_tokens,
};
const perModel = Object.fromEntries(
  Object.entries(result.modelUsage ?? {}).map(([model, m]) => [
    model,
    { input_uncached: m.inputTokens, input_cache_read: m.cacheReadInputTokens, input_cache_write: m.cacheCreationInputTokens, output_total: m.outputTokens },
  ]),
);
const modelSum = Object.values(perModel).reduce(
  (acc, m) => {
    for (const k of Object.keys(acc)) acc[k] += m[k] ?? 0;
    return acc;
  },
  { input_uncached: 0, input_cache_read: 0, input_cache_write: 0, output_total: 0 },
);
const total = (o) => ['input_uncached', 'input_cache_read', 'input_cache_write', 'output_total'].reduce((n, k) => n + (o[k] ?? 0), 0);

console.log(
  JSON.stringify(
    {
      result_fields: Object.keys(result).sort(),
      num_turns: result.num_turns,
      is_error: result.is_error,
      transcript,
      transcript_total: total(transcript),
      headless_usage: headlessTop,
      headless_usage_total: total(headlessTop),
      headless_model_usage: perModel,
      headless_model_usage_total: total(modelSum),
      unobserved_in_transcript: parsed.unobservedRequests ?? [],
      difference_model_usage_minus_transcript: total(modelSum) - total(transcript),
    },
    null,
    2,
  ),
);
