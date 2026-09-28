import { USAGE_FIELDS, type RequestUsage, type UsageEvent, type UsageField } from '../schema/events.js';

export type Counts = Record<UsageField, number>;

export interface CumulativeSample {
  request_id: string;
  counters: Partial<Counts>;
}

export interface DeltaResult {
  usage: RequestUsage[];
  resets: { request_id: string; fields: UsageField[] }[];
}

/**
 * Converts cumulative per-stream counters into per-request deltas. A counter
 * that goes down is treated as a reset: the new value is the delta since the
 * reset. Missing counters make that request incomplete instead of zero.
 */
export function cumulativeToDeltas(samples: CumulativeSample[]): DeltaResult {
  const prev: Partial<Counts> = {};
  const usage: RequestUsage[] = [];
  const resets: DeltaResult['resets'] = [];
  for (const s of samples) {
    const delta: Partial<Counts> = {};
    const missing: UsageField[] = [];
    const resetFields: UsageField[] = [];
    for (const f of USAGE_FIELDS) {
      const cur = s.counters[f];
      if (cur === undefined) {
        missing.push(f);
        continue;
      }
      const before = prev[f];
      if (before === undefined) {
        // First observation of this counter: the whole value belongs to this request
        // only if the stream starts here; we cannot know, so it is the delta from 0.
        delta[f] = cur;
      } else if (cur < before) {
        resetFields.push(f);
        delta[f] = cur;
      } else {
        delta[f] = cur - before;
      }
      prev[f] = cur;
    }
    if (resetFields.length) resets.push({ request_id: s.request_id, fields: resetFields });
    usage.push(
      missing.length === 0
        ? { request_id: s.request_id, ...(delta as Counts), scope: 'request', origin: 'provider_reported', completeness: 'complete' }
        : {
            request_id: s.request_id,
            ...delta,
            scope: 'request',
            origin: 'provider_reported',
            completeness: 'incomplete',
            missing_fields: missing,
          },
    );
  }
  return { usage, resets };
}

/**
 * For providers whose input total already contains cached tokens. Returns
 * undefined when the parts do not fit (caller must mark the request incomplete).
 */
export function splitInclusiveInput(inputTotal: number, cacheRead: number, cacheWrite: number): number | undefined {
  const uncached = inputTotal - cacheRead - cacheWrite;
  return uncached >= 0 ? uncached : undefined;
}

export interface UsageSummary {
  completeness: 'complete' | 'incomplete' | 'not_evaluable';
  requests_counted: number;
  duplicate_request_ids: string[];
  conflicting_request_ids: string[];
  incomplete_requests: { request_id: string; missing_fields: string[] }[];
  /** Sum over unique requests; null unless every request is complete and there is at least one. */
  t_task: number | null;
  /** Sums over the complete requests only; shown for diagnostics, never as T_task. */
  observed_totals: Counts;
  reasoning_included_in_output: number | null;
  per_stream: Record<string, { requests: number; observed_total: number }>;
  gaps: string[];
}

const same = (a: RequestUsage, b: RequestUsage) => USAGE_FIELDS.every((f) => a[f] === b[f]);

export function requestTotal(u: Counts): number {
  return u.input_uncached + u.input_cache_read + u.input_cache_write + u.output_total;
}

/**
 * T_task = sum over unique requests of (uncached + cache_read + cache_write + output_total).
 * Requests are deduplicated by request_id across streams, so a sub-agent request
 * surfaced in both parent and child logs is counted once.
 */
export function summarizeUsage(
  events: UsageEvent[],
  extraGaps: string[] = [],
  /** The adapter knows some model requests are not in the input (e.g. compaction calls). */
  knownMissingRequests = false,
): UsageSummary {
  const byId = new Map<string, { usage: RequestUsage; stream: string }>();
  const duplicates = new Set<string>();
  const conflicts = new Set<string>();
  for (const ev of events) {
    const id = ev.usage.request_id;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { usage: ev.usage, stream: ev.stream_id });
    } else if (same(existing.usage, ev.usage) && existing.usage.completeness === ev.usage.completeness) {
      duplicates.add(id);
    } else {
      conflicts.add(id);
    }
  }

  const totals: Counts = { input_uncached: 0, input_cache_read: 0, input_cache_write: 0, output_total: 0 };
  const incomplete: UsageSummary['incomplete_requests'] = [];
  const perStream: UsageSummary['per_stream'] = {};
  let reasoning = 0;
  let reasoningKnown = true;
  for (const [id, { usage, stream }] of byId) {
    if (usage.completeness === 'incomplete') {
      incomplete.push({ request_id: id, missing_fields: usage.missing_fields });
      continue;
    }
    if (conflicts.has(id)) continue;
    for (const f of USAGE_FIELDS) totals[f] += usage[f];
    if (usage.reasoning_included_in_output === undefined) reasoningKnown = false;
    else reasoning += usage.reasoning_included_in_output;
    const ps = (perStream[stream] ??= { requests: 0, observed_total: 0 });
    ps.requests += 1;
    ps.observed_total += requestTotal(usage);
  }

  const gaps = [...extraGaps];
  if (conflicts.size) gaps.push(`${conflicts.size} request id(s) reported with conflicting counts`);
  if (incomplete.length) gaps.push(`${incomplete.length} request(s) with missing usage fields`);

  let completeness: UsageSummary['completeness'];
  if (byId.size === 0) {
    completeness = 'not_evaluable';
    gaps.push('no usage events');
  } else if (incomplete.length || conflicts.size || knownMissingRequests) {
    completeness = 'incomplete';
  } else {
    completeness = 'complete';
  }

  return {
    completeness,
    requests_counted: byId.size - incomplete.length - conflicts.size,
    duplicate_request_ids: [...duplicates],
    conflicting_request_ids: [...conflicts],
    incomplete_requests: incomplete,
    t_task: completeness === 'complete' ? requestTotal(totals) : null,
    observed_totals: totals,
    reasoning_included_in_output: reasoningKnown && byId.size > 0 ? reasoning : null,
    per_stream: perStream,
    gaps,
  };
}
