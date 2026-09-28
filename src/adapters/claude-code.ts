import { createHash } from 'node:crypto';
import type { CanonicalEvent, ErrorKind, RequestUsage, ToolCategory } from '../schema/events.js';
import { isLineError, readJsonl } from './jsonl.js';
import { InvalidInputError, type Adapter, type Coverage, type ParseOptions, type ParseResult } from './types.js';

/**
 * Experimental adapter for Claude Code session transcripts
 * (~/.claude/projects/<project>/<session>.jsonl). The transcript format is not
 * a documented stable API; see docs/adapters.md for what was verified and how.
 */

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const sha256 = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

const TOOL_CATEGORY: Record<string, ToolCategory> = {
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  Bash: 'shell',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
};

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : isObj(c) ? JSON.stringify(c) : String(c)))
      .join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content);
}

function classifyShellError(text: string, exitCode: number | undefined): ErrorKind | undefined {
  if (exitCode === 127 || /(^|\n|: )command not found\b/i.test(text) || /\bnot found: /i.test(text)) {
    return 'command_not_found';
  }
  if (/Cannot find module ['"]/.test(text) || /ModuleNotFoundError: No module named/.test(text)) {
    return 'module_not_found';
  }
  if (/\bENOENT\b.*\bspawn\b/.test(text)) return 'missing_executable';
  return undefined;
}

function toolArgs(name: string, input: Json): { args: Json; path?: string; range?: { start: number; end: number }; expandedFrom?: string } {
  switch (TOOL_CATEGORY[name]) {
    case 'read': {
      const path = str(input.file_path);
      const offset = num(input.offset);
      const limit = num(input.limit);
      const range = offset !== undefined || limit !== undefined
        ? { start: offset ?? 1, end: (offset ?? 1) + (limit ?? 0) }
        : undefined;
      return { args: { path, offset, limit }, ...(path ? { path } : {}), ...(range ? { range } : {}) };
    }
    case 'search': {
      const { pattern, path, ...flags } = input;
      return { args: { query: pattern, scope: path ?? null, flags } };
    }
    case 'shell': {
      const command = str(input.command) ?? '';
      const expand = /\bagent-efficiency\s+expand\s+(ae_\d{14}_[0-9a-f]{8})\b/.exec(command);
      return { args: { command: input.command, cwd: null }, ...(expand ? { expandedFrom: expand[1] } : {}) };
    }
    case 'edit': {
      const path = str(input.file_path) ?? str(input.notebook_path);
      return { args: { path }, ...(path ? { path } : {}) };
    }
    default:
      return { args: {} };
  }
}

interface PendingUsage {
  requestId: string;
  sequence: number;
  line: number;
  streamId: string;
  sessionId: string;
  timestamp?: string;
  fields: Json;
  outputSeen: number[];
}

export const claudeCodeAdapter: Adapter = {
  info: {
    id: 'claude-code',
    host: 'Claude Code session transcript JSONL',
    status: 'experimental',
    tested_versions: ['2.1.283 (VS Code extension; one main-thread session, no sub-agents or compaction in the sample)'],
    fixtures: [
      'fixtures/real/claude-code-2.1.283/session.deidentified.jsonl (real structure, text replaced by hashes)',
      'fixtures/synthetic/claude-code/session.jsonl (synthetic: sidechain, compaction, command-not-found)',
    ],
    observable: {
      tools: 'tool_use / tool_result blocks in the main transcript. Read, Grep, Glob, Bash, Edit/Write mapped; others = other.',
      subagents: 'Only sidechain entries present in the given file (isSidechain=true) as separate streams. Sub-agent transcripts stored in separate files are NOT included.',
      compaction: 'system entries with subtype compact_boundary become context boundaries. The compaction model call usage is not in the transcript (reported as a gap).',
    },
    usage_semantics: 'message.usage per assistant API response; one response may span several lines sharing requestId/message.id. Deduplicated by request id; the largest output_tokens seen is used.',
    cache_semantics: 'input_tokens, cache_read_input_tokens, cache_creation_input_tokens treated as mutually exclusive (Anthropic Messages API semantics).',
    reasoning_semantics: 'output_tokens includes extended-thinking tokens; not split.',
    limitations: [
      'Transcript format is undocumented and may change between Claude Code versions.',
      'Verified on one real 2.1.283 session only; sub-agent and compaction handling are tested on synthetic data only.',
      'Title-generation and permission-classifier calls leave traces but no usage, so T_task is reported incomplete when they appear.',
      'Shell cwd is not recorded per call; R003 groups by command only within one stream.',
      'Compaction and some internal model calls are not observable, so T_task from this adapter is a lower bound.',
    ],
  },

  async parse(path: string, options: ParseOptions): Promise<ParseResult> {
    const events: CanonicalEvent[] = [];
    const warnings = new Set<string>();
    const coverage: Coverage = {
      input_id: options.inputId,
      total_lines: 0,
      parsed_lines: 0,
      ignored_lines: 0,
      skipped: [],
      partial: false,
    };
    const toolCalls = new Map<string, { name: string; category: ToolCategory; streamId: string; path?: string; wrapperPolicy?: string }>();
    const usage = new Map<string, PendingUsage>();
    const epochs = new Map<string, number>();
    const unobserved = new Set<string>();
    let seq = 0;
    let recognised = 0;

    const base = (streamId: string, sessionId: string, line: number, timestamp: string | undefined, id: string) => {
      const epoch = epochs.get(streamId) ?? 0;
      return {
        schema_version: 2 as const,
        id,
        task_id: sessionId,
        run_id: options.inputId,
        session_id: sessionId,
        stream_id: streamId,
        context_epoch: `e${epoch}`,
        sequence: seq++,
        ...(timestamp ? { timestamp } : {}),
        source_ref: { input_id: options.inputId, line },
      };
    };

    for await (const item of readJsonl(path, { maxLineBytes: options.maxLineBytes })) {
      coverage.total_lines = Math.max(coverage.total_lines, item.line);
      if (isLineError(item)) {
        if (options.strict) throw new InvalidInputError(`line ${item.line}: ${item.message}`, item.line);
        coverage.skipped.push({ line: item.line, reason: `${item.kind}: ${item.message}` });
        continue;
      }
      const e = item.value;
      if (!isObj(e) || typeof e.type !== 'string') {
        if (options.strict) throw new InvalidInputError(`line ${item.line}: not a transcript entry`, item.line);
        coverage.skipped.push({ line: item.line, reason: 'not a transcript entry' });
        continue;
      }
      const sessionId = str(e.sessionId) ?? 'unknown-session';
      const streamId = e.isSidechain === true ? `sidechain:${str(e.agentId) ?? 'unknown'}` : 'main';
      const timestamp = str(e.timestamp);
      const lineId = str(e.uuid) ?? `L${item.line}`;

      if (e.type === 'system' && e.subtype === 'compact_boundary') {
        recognised++;
        coverage.parsed_lines++;
        const next = (epochs.get(streamId) ?? 0) + 1;
        events.push({ ...base(streamId, sessionId, item.line, timestamp, lineId), type: 'context_boundary', kind: 'compaction', next_epoch: `e${next}` });
        epochs.set(streamId, next);
        warnings.add('Compaction detected; the compaction model call usage is not present in the transcript.');
        unobserved.add('compaction model call(s)');
        continue;
      }
      if (e.type === 'ai-title') unobserved.add('session title generation call(s) (ai-title entries)');
      if (e.serverClassifierRequest !== undefined) unobserved.add('permission-classifier call(s) (serverClassifierRequest)');

      if ((e.type !== 'user' && e.type !== 'assistant') || !isObj(e.message)) {
        coverage.ignored_lines++;
        continue;
      }
      recognised++;
      coverage.parsed_lines++;
      const msg = e.message;
      const content = msg.content;

      if (e.type === 'assistant') {
        const requestId = str(e.requestId) ?? str(msg.id);
        if (isObj(msg.usage)) {
          if (!requestId) {
            warnings.add('Assistant usage without request id; not counted.');
          } else {
            const prev = usage.get(requestId);
            const out = num(msg.usage.output_tokens);
            if (prev) {
              if (out !== undefined) prev.outputSeen.push(out);
            } else {
              usage.set(requestId, {
                requestId,
                sequence: seq++,
                line: item.line,
                streamId,
                sessionId,
                ...(timestamp ? { timestamp } : {}),
                fields: msg.usage,
                outputSeen: out !== undefined ? [out] : [],
              });
            }
          }
        }
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!isObj(block) || block.type !== 'tool_use') continue;
            const id = str(block.id);
            const name = str(block.name) ?? 'unknown';
            if (!id) continue;
            const category = TOOL_CATEGORY[name] ?? 'other';
            const input = isObj(block.input) ? block.input : {};
            const { args, path: p, range, expandedFrom } = toolArgs(name, input);
            const command = str(input.command) ?? '';
            const wrapperPolicy = /\bagent-efficiency\s+test\b/.test(command) ? (/--policy[= ](\S+)/.exec(command)?.[1] ?? 'none') : undefined;
            toolCalls.set(id, { name, category, streamId, ...(p ? { path: p } : {}), ...(wrapperPolicy ? { wrapperPolicy } : {}) });
            events.push({
              ...base(streamId, sessionId, item.line, timestamp, `${lineId}:${id}:call`),
              type: 'tool_call',
              tool_call_id: id,
              category,
              tool_name: name,
              args,
              ...(p ? { path: p } : {}),
              ...(range ? { range } : {}),
              ...(expandedFrom ? { expanded_from_artifact_id: expandedFrom } : {}),
            });
          }
        }
        continue;
      }

      // user entry
      if (typeof content === 'string' || (Array.isArray(content) && content.some((b) => isObj(b) && b.type === 'text'))) {
        if (e.isMeta !== true && e.isCompactSummary !== true) {
          const text = typeof content === 'string' ? content : toolResultText(content);
          events.push({ ...base(streamId, sessionId, item.line, timestamp, `${lineId}:user`), type: 'user_message', text_hash: sha256(text) });
        }
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isObj(block) || block.type !== 'tool_result') continue;
        const id = str(block.tool_use_id);
        if (!id) continue;
        const call = toolCalls.get(id);
        if (!call) warnings.add('tool_result without a matching tool_use in this file (possibly truncated or resumed session).');
        const text = toolResultText(block.content);
        const isError = block.is_error === true;
        const exitMatch = /^Exit code (\d+)/m.exec(text);
        const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
        const category = call?.category ?? 'other';
        const errorKind = category === 'shell' && isError ? classifyShellError(text, exitCode) : undefined;
        const artifactId = call?.wrapperPolicy ? /\bae_\d{14}_[0-9a-f]{8}\b/.exec(text)?.[0] : undefined;
        events.push({
          ...base(call?.streamId ?? streamId, sessionId, item.line, timestamp, `${lineId}:${id}:result`),
          type: 'tool_result',
          tool_call_id: id,
          category,
          tool_name: call?.name ?? 'unknown',
          ...(call?.path ? { path: call.path } : {}),
          content_hash: sha256(text),
          output_bytes: Buffer.byteLength(text, 'utf8'),
          ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
          ...(errorKind ? { error_kind: errorKind } : isError && category === 'shell' ? { error_kind: 'other' as const } : {}),
          ...(artifactId ? { artifact_id: artifactId, ...(call?.wrapperPolicy !== 'none' ? { policy_id: call?.wrapperPolicy } : {}) } : {}),
        });
        if (call?.category === 'edit' && call.path && !isError) {
          events.push({
            ...base(call.streamId, sessionId, item.line, timestamp, `${lineId}:${id}:change`),
            type: 'file_change',
            path: call.path,
            tool_call_id: id,
            change: 'modified',
          });
        }
      }
    }

    for (const u of usage.values()) {
      const fieldMap = {
        input_uncached: num(u.fields.input_tokens),
        input_cache_read: num(u.fields.cache_read_input_tokens),
        input_cache_write: num(u.fields.cache_creation_input_tokens),
        output_total: u.outputSeen.length > 0 ? Math.max(...u.outputSeen) : undefined,
      };
      const missing = Object.entries(fieldMap).filter(([, v]) => v === undefined).map(([k]) => k);
      const usageRecord: RequestUsage = missing.length === 0
        ? {
            request_id: u.requestId,
            input_uncached: fieldMap.input_uncached!,
            input_cache_read: fieldMap.input_cache_read!,
            input_cache_write: fieldMap.input_cache_write!,
            output_total: fieldMap.output_total!,
            scope: 'request',
            origin: 'provider_reported',
            completeness: 'complete',
          }
        : {
            request_id: u.requestId,
            ...Object.fromEntries(Object.entries(fieldMap).filter(([, v]) => v !== undefined)),
            scope: 'request',
            origin: 'provider_reported',
            completeness: 'incomplete',
            missing_fields: missing,
          };
      events.push({
        ...base(u.streamId, u.sessionId, u.line, u.timestamp, `usage:${u.requestId}`),
        sequence: u.sequence,
        type: 'usage',
        usage: usageRecord,
      });
    }

    coverage.partial = coverage.skipped.length > 0;
    if (recognised === 0 && coverage.total_lines > 0) {
      throw new InvalidInputError('no Claude Code transcript entries recognised; wrong --adapter?');
    }
    events.sort((a, b) => a.sequence - b.sequence);
    return { events, coverage, warnings: [...warnings], unobservedRequests: [...unobserved] };
  },
};
