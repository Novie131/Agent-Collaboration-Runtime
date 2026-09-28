import { CanonicalEvent } from '../schema/events.js';
import { isLineError, readJsonl } from './jsonl.js';
import { InvalidInputError, type Adapter, type Coverage, type ParseOptions, type ParseResult } from './types.js';

export const canonicalAdapter: Adapter = {
  info: {
    id: 'canonical',
    host: 'agent-efficiency canonical JSONL (schema_version 2)',
    status: 'supported',
    tested_versions: ['schema_version 2'],
    fixtures: ['fixtures/synthetic/canonical/'],
    observable: {
      tools: 'Whatever the producer emitted as tool_call/tool_result events.',
      subagents: 'Separate stream_id per sub-agent; never merged by rules.',
      compaction: 'context_boundary events.',
    },
    usage_semantics: 'Per-request usage events (scope=request). Cumulative counters must be converted by the producing adapter.',
    cache_semantics: 'input_uncached, input_cache_read, input_cache_write are mutually exclusive by contract.',
    reasoning_semantics: 'output_total already includes reasoning; reasoning_included_in_output is display-only.',
    limitations: ['Correctness of the counts depends on the producer honouring the contract.'],
  },

  async parse(path: string, options: ParseOptions): Promise<ParseResult> {
    const events: CanonicalEvent[] = [];
    const coverage: Coverage = {
      input_id: options.inputId,
      total_lines: 0,
      parsed_lines: 0,
      ignored_lines: 0,
      skipped: [],
      partial: false,
    };

    for await (const item of readJsonl(path, { maxLineBytes: options.maxLineBytes })) {
      coverage.total_lines = Math.max(coverage.total_lines, item.line);
      if (isLineError(item)) {
        if (options.strict) throw new InvalidInputError(`line ${item.line}: ${item.message}`, item.line);
        coverage.skipped.push({ line: item.line, reason: `${item.kind}: ${item.message}` });
        continue;
      }
      const raw = item.value;
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && !('source_ref' in raw)) {
        (raw as Record<string, unknown>).source_ref = { input_id: options.inputId, line: item.line };
      }
      const parsed = CanonicalEvent.safeParse(raw);
      if (!parsed.success) {
        const reason = parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        if (options.strict) throw new InvalidInputError(`line ${item.line}: ${reason}`, item.line);
        coverage.skipped.push({ line: item.line, reason: `schema: ${reason}` });
        continue;
      }
      coverage.parsed_lines += 1;
      events.push(parsed.data);
    }
    coverage.partial = coverage.skipped.length > 0;
    if (coverage.parsed_lines === 0 && coverage.total_lines > 0) {
      throw new InvalidInputError('no line matched the canonical schema; wrong --adapter?');
    }
    return { events, coverage, warnings: [] };
  },
};
