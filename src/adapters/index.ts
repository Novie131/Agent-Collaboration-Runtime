import { canonicalAdapter } from './canonical.js';
import { claudeCodeAdapter } from './claude-code.js';
import type { Adapter, AdapterInfo } from './types.js';

/** Codex is listed so `adapters` reports it honestly; there is no parser until a real sample is verified. */
export const codexInfo: AdapterInfo = {
  id: 'codex',
  host: 'OpenAI Codex CLI session logs',
  status: 'unsupported',
  tested_versions: [],
  fixtures: [],
  observable: {
    tools: 'unknown (not verified)',
    subagents: 'unknown (not verified)',
    compaction: 'unknown (not verified)',
  },
  usage_semantics: 'not verified; logs are believed to carry cumulative token counters that must be converted to deltas (src/observe/usage.ts supports this).',
  cache_semantics: 'not verified; input is believed to include cached input, which must be split before use.',
  reasoning_semantics: 'not verified.',
  limitations: ['No parser. Convert Codex logs to the canonical schema yourself, or contribute a verified adapter.'],
};

export const ADAPTERS: Record<string, Adapter> = {
  canonical: canonicalAdapter,
  'claude-code': claudeCodeAdapter,
};

export function listAdapterInfo(): AdapterInfo[] {
  return [...Object.values(ADAPTERS).map((a) => a.info), codexInfo];
}
