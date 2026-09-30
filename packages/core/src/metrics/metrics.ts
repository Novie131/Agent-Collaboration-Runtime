import type { UsageEvent } from '@acr/protocol/transcript-events.js';
import { ESTIMATOR_ID } from '@acr/platform/tokens.js';
import type { HubStore } from '@acr/storage/hub-store.js';
import { claudeCodeAdapter } from '@acr/transcripts/claude-code.js';
import { summarizeUsage, type UsageSummary } from '@acr/transcripts/usage.js';

/** Reads usage events from an agent transcript. Offline: local files only. */
export interface TranscriptUsageReader {
  read(transcriptPath: string): Promise<{ events: UsageEvent[]; gaps: string[] }>;
}

export const claudeTranscriptReader: TranscriptUsageReader = {
  async read(path) {
    const parsed = await claudeCodeAdapter.parse(path, { strict: false, maxLineBytes: 16 * 1024 * 1024, inputId: 'transcript' });
    const events = parsed.events.filter((e): e is UsageEvent => e.type === 'usage');
    return { events, gaps: parsed.unobservedRequests ?? [] };
  },
};

/**
 * ChatGPT-side estimate (SPEC §29.2): every remote tool call's request + response stays in the
 * conversation, so it is paid again on each later turn. Later remote calls for the same task are a
 * lower bound on later turns; turns without tool calls are invisible to the hub.
 */
export function chatgptToolIoEstimate(calls: { endpoint: string; request_tokens: number; response_tokens: number; estimator: string }[]) {
  const remote = calls.filter((c) => c.endpoint === 'remote');
  let total = 0;
  const once = remote.reduce((a, c) => a + c.request_tokens + c.response_tokens, 0);
  remote.forEach((c, i) => {
    total += (c.request_tokens + c.response_tokens) * (1 + (remote.length - 1 - i));
  });
  return {
    kind: 'estimated' as const,
    bound: 'lower' as const,
    estimator: [...new Set(remote.map((c) => c.estimator))].join(',') || ESTIMATOR_ID,
    tool_calls: remote.length,
    tool_io_once: once,
    tool_io_cumulative: total,
  };
}

export type TokenBreakdown = { input_uncached: number; input_cache_read: number; input_cache_write: number; output: number };

export type ClaudeMeasured = {
  kind: 'measured';
  bound: 'lower' | 'exact';
  sessions: number;
  requests: number;
  tokens: number | null;
  observed_tokens: number;
  /** Cache reads dominate agent sessions and are priced far below fresh input, so totals alone mislead. */
  breakdown: TokenBreakdown;
  completeness: UsageSummary['completeness'] | 'no_session';
  gaps: string[];
};

const EMPTY_BREAKDOWN: TokenBreakdown = { input_uncached: 0, input_cache_read: 0, input_cache_write: 0, output: 0 };

/**
 * Claude-side measurement (SPEC §29.1): usage requests from the task's session transcripts that
 * fall between the first ACR tool call reported for the task in that session (with a lead for the
 * request that made it) and the request right after the last one (the model's reply to that tool
 * result, e.g. its closing summary).
 */
export async function claudeMeasured(store: HubStore, taskId: string, reader: TranscriptUsageReader | null): Promise<ClaudeMeasured> {
  const sessions = store.listSessions(taskId);
  if (!reader || sessions.length === 0) {
    return {
      kind: 'measured',
      bound: 'lower',
      sessions: 0,
      requests: 0,
      tokens: null,
      observed_tokens: 0,
      breakdown: { ...EMPTY_BREAKDOWN },
      completeness: 'no_session',
      gaps: [reader ? 'no Claude Code session was reported for this task (is the ACR plugin hook installed?)' : 'transcript reading disabled'],
    };
  }
  const bySession = new Map<string, { path: string; from: string; to: string }>();
  for (const s of sessions) {
    const cur = bySession.get(s.session_id);
    if (!cur) bySession.set(s.session_id, { path: s.transcript_path, from: s.timestamp, to: s.timestamp });
    else {
      if (s.timestamp < cur.from) cur.from = s.timestamp;
      if (s.timestamp > cur.to) cur.to = s.timestamp;
    }
  }
  const events: UsageEvent[] = [];
  const gaps = new Set<string>();
  for (const [sessionId, w] of bySession) {
    try {
      const r = await reader.read(w.path);
      r.gaps.forEach((g) => gaps.add(g));
      // The request that called get_task happened just before the hook reported it; allow a small lead.
      const from = new Date(Date.parse(w.from) - 120_000).toISOString();
      const timed = r.events.filter((e) => {
        if (e.timestamp) return true;
        gaps.add('usage events without timestamps were skipped');
        return false;
      });
      events.push(...timed.filter((e) => e.timestamp! >= from && e.timestamp! <= w.to));
      // The reply to the last ACR tool result belongs to the task too: include the next request after `to`.
      const after = timed.filter((e) => e.timestamp! > w.to).sort((a, b) => a.timestamp!.localeCompare(b.timestamp!));
      const nextId = after[0]?.usage.request_id;
      if (nextId) events.push(...after.filter((e) => e.usage.request_id === nextId));
    } catch (err) {
      gaps.add(`session ${sessionId}: transcript unreadable (${(err as Error).message})`);
    }
  }
  const summary = summarizeUsage(events, [...gaps], gaps.size > 0);
  const observed =
    summary.observed_totals.input_uncached + summary.observed_totals.input_cache_read + summary.observed_totals.input_cache_write + summary.observed_totals.output_total;
  return {
    kind: 'measured',
    bound: summary.completeness === 'complete' ? 'exact' : 'lower',
    sessions: bySession.size,
    requests: summary.requests_counted,
    tokens: summary.t_task,
    observed_tokens: observed,
    breakdown: {
      input_uncached: summary.observed_totals.input_uncached,
      input_cache_read: summary.observed_totals.input_cache_read,
      input_cache_write: summary.observed_totals.input_cache_write,
      output: summary.observed_totals.output_total,
    },
    completeness: summary.completeness,
    gaps: summary.gaps,
  };
}

/** Per-task metrics. Measured and estimated numbers are reported side by side and never summed (ADR-0006). */
export async function taskMetrics(store: HubStore, taskId: string, reader: TranscriptUsageReader | null) {
  const calls = store.listToolCalls(taskId);
  const local = calls.filter((c) => c.endpoint === 'local');
  const events = store.listEvents(taskId);
  const count = (type: string) => events.filter((e) => e.type === type).length;
  return {
    task_id: taskId,
    claude: await claudeMeasured(store, taskId, reader),
    chatgpt: chatgptToolIoEstimate(calls),
    diagnostics: {
      local_tool_calls: local.length,
      local_tool_io: local.reduce((a, c) => a + c.request_tokens + c.response_tokens, 0),
      claims: count('TASK_CLAIMED'),
      results: count('RESULT_SUBMITTED'),
      reviews: count('REVIEW_SUBMITTED'),
      context_requests: count('CONTEXT_REQUESTED'),
    },
    note: 'claude = measured from transcripts (lower bound unless complete); chatgpt = estimated tool I/O (lower bound). Never add them.',
  };
}
