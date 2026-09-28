import { z } from 'zod';
import type { CanonicalEvent, SourceRef, ToolCallEvent, ToolResultEvent } from '../schema/events.js';
import { displayPath, redactText } from '../privacy/redact.js';

export const RuleConfig = z
  .object({
    R001: z.object({ window_calls: z.number().int().positive(), min_repeats: z.number().int().min(2) }).strict(),
    R002: z.object({ window_calls: z.number().int().positive(), min_repeats: z.number().int().min(2) }).strict(),
    R003: z.object({ window_calls: z.number().int().positive(), min_repeats: z.number().int().min(2) }).strict(),
    R004: z.object({ window_calls: z.number().int().positive() }).strict(),
  })
  .strict();
export type RuleConfig = z.infer<typeof RuleConfig>;

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  R001: { window_calls: 20, min_repeats: 3 },
  R002: { window_calls: 20, min_repeats: 3 },
  R003: { window_calls: 10, min_repeats: 3 },
  R004: { window_calls: 10 },
};

export type RuleId = 'R001' | 'R002' | 'R003' | 'R004';
export type Confidence = 'high' | 'medium' | 'low';

export interface Finding {
  id: string;
  rule: RuleId;
  title: string;
  session_id: string;
  stream_id: string;
  context_epoch: string | null;
  subject: string;
  occurrences: number;
  event_ids: string[];
  source_refs: SourceRef[];
  confidence: Confidence;
  causality: 'n/a' | 'unproven';
  limitations: string[];
  suggestion: string;
}

export interface NotEvaluable {
  rule: RuleId;
  reason: string;
  count: number;
}

export interface RuleOutput {
  findings: Finding[];
  not_evaluable: NotEvaluable[];
  streams_analysed: number;
}

interface Op {
  callIndex: number;
  toolCallId: string;
  call?: ToolCallEvent;
  result?: ToolResultEvent;
}

type TimelineItem =
  | { kind: 'op'; op: Op }
  | { kind: 'file_change'; path: string }
  | { kind: 'user_message'; newRequirement: boolean }
  | { kind: 'other' };

interface StreamGroup {
  session_id: string;
  stream_id: string;
  context_epoch: string | null;
  timeline: TimelineItem[];
}

const ENV_ERRORS = new Set(['command_not_found', 'missing_executable', 'module_not_found']);

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

function groupStreams(events: CanonicalEvent[]): StreamGroup[] {
  const groups = new Map<string, StreamGroup>();
  const opsById = new Map<string, Op>();
  const counters = new Map<string, number>();
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);

  for (const ev of sorted) {
    const epoch = ev.context_epoch ?? null;
    const key = `${ev.session_id}\u0000${ev.stream_id}\u0000${epoch ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { session_id: ev.session_id, stream_id: ev.stream_id, context_epoch: epoch, timeline: [] };
      groups.set(key, g);
    }
    switch (ev.type) {
      case 'tool_call': {
        const n = (counters.get(key) ?? 0) + 1;
        counters.set(key, n);
        const op: Op = { callIndex: n, toolCallId: ev.tool_call_id, call: ev };
        opsById.set(`${key}\u0000${ev.tool_call_id}`, op);
        g.timeline.push({ kind: 'op', op });
        break;
      }
      case 'tool_result': {
        const op = opsById.get(`${key}\u0000${ev.tool_call_id}`);
        if (op) {
          op.result = ev;
        } else {
          // Result without a call in this stream: still an operation, positioned here.
          const n = (counters.get(key) ?? 0) + 1;
          counters.set(key, n);
          const orphan: Op = { callIndex: n, toolCallId: ev.tool_call_id, result: ev };
          opsById.set(`${key}\u0000${ev.tool_call_id}`, orphan);
          g.timeline.push({ kind: 'op', op: orphan });
        }
        break;
      }
      case 'file_change':
        g.timeline.push({ kind: 'file_change', path: normPath(ev.path) });
        break;
      case 'user_message':
        g.timeline.push({ kind: 'user_message', newRequirement: ev.new_requirement !== false });
        break;
      default:
        g.timeline.push({ kind: 'other' });
    }
  }
  return [...groups.values()];
}

const category = (op: Op) => op.call?.category ?? op.result?.category;
const eventIds = (op: Op) => [op.call?.id, op.result?.id].filter((x): x is string => !!x);
const refs = (op: Op) => [op.call?.source_ref, op.result?.source_ref].filter((x): x is SourceRef => !!x);

class FindingBuilder {
  private seq = 0;
  readonly findings: Finding[] = [];
  private readonly notEval = new Map<string, NotEvaluable>();

  constructor(private readonly projectRoot?: string) {}

  subjectPath(p: string) {
    return redactText(displayPath(p, this.projectRoot));
  }

  add(g: StreamGroup, f: Omit<Finding, 'id' | 'session_id' | 'stream_id' | 'context_epoch'>): Finding {
    const finding: Finding = {
      id: `F${String(++this.seq).padStart(4, '0')}`,
      session_id: g.session_id,
      stream_id: g.stream_id,
      context_epoch: g.context_epoch,
      ...f,
    };
    this.findings.push(finding);
    return finding;
  }

  notEvaluable(rule: RuleId, reason: string) {
    const k = `${rule}:${reason}`;
    const cur = this.notEval.get(k) ?? { rule, reason, count: 0 };
    cur.count += 1;
    this.notEval.set(k, cur);
  }

  get notEvaluableList() {
    return [...this.notEval.values()];
  }
}

function extend(f: Finding, op: Op) {
  f.occurrences += 1;
  f.event_ids.push(...eventIds(op));
  f.source_refs.push(...refs(op));
}

function r001(g: StreamGroup, cfg: RuleConfig['R001'], fb: FindingBuilder) {
  let history: { op: Op; key: string; path: string }[] = [];
  const active = new Map<string, { finding: Finding; last: number }>();
  for (const item of g.timeline) {
    if (item.kind === 'user_message') {
      if (item.newRequirement) {
        history = [];
        active.clear();
      }
      continue;
    }
    if (item.kind === 'file_change') {
      history = history.filter((h) => h.path !== item.path);
      for (const [k, a] of active) if (k.startsWith(`${item.path}\u0000`)) active.delete(k);
      continue;
    }
    if (item.kind !== 'op' || category(item.op) !== 'read') continue;
    const op = item.op;
    const path = op.call?.path ?? op.result?.path;
    const hash = op.result?.content_hash;
    if (!path) {
      fb.notEvaluable('R001', 'read without path');
      continue;
    }
    if (!op.result) {
      fb.notEvaluable('R001', 'read call without result');
      continue;
    }
    if (!hash) {
      fb.notEvaluable('R001', 'read result without content_hash');
      continue;
    }
    const range = op.call?.range ?? op.result.range;
    const np = normPath(path);
    const version = op.result.file_version_hash ?? '';
    const key = `${np}\u0000${range ? `${range.start}-${range.end}` : 'full'}\u0000${hash}\u0000${version}`;
    history = history.filter((h) => op.callIndex - h.op.callIndex < cfg.window_calls);
    history.push({ op, key, path: np });
    const act = active.get(key);
    if (act && op.callIndex - act.last < cfg.window_calls) {
      extend(act.finding, op);
      act.last = op.callIndex;
      continue;
    }
    const matches = history.filter((h) => h.key === key);
    if (matches.length >= cfg.min_repeats) {
      const limitations = [
        'A repeated read can be a legitimate re-check (e.g. before editing); this is a candidate, not proof of waste.',
      ];
      if (range) limitations.push('Hash covers only the read range, not the whole file version.');
      if (!op.result.file_version_hash) limitations.push('No file version hash; unobserved external changes cannot be ruled out.');
      const finding = fb.add(g, {
        rule: 'R001',
        title: 'Repeated identical read',
        subject: `${fb.subjectPath(path)}${range ? `:${range.start}-${range.end}` : ''}`,
        occurrences: 0,
        event_ids: [],
        source_refs: [],
        confidence: op.result.file_version_hash ? 'high' : 'medium',
        causality: 'n/a',
        limitations,
        suggestion: 'Keep the needed excerpt in working notes or read a narrower range; re-read only after a change or when re-verifying.',
      });
      for (const m of matches) extend(finding, m.op);
      active.set(key, { finding, last: op.callIndex });
    }
  }
}

function r002(g: StreamGroup, cfg: RuleConfig['R002'], fb: FindingBuilder) {
  let history: { op: Op; key: string }[] = [];
  const active = new Map<string, { finding: Finding; last: number }>();
  for (const item of g.timeline) {
    if (item.kind === 'user_message') {
      if (item.newRequirement) {
        history = [];
        active.clear();
      }
      continue;
    }
    if (item.kind === 'file_change') {
      // Any edit can change search results.
      history = [];
      active.clear();
      continue;
    }
    if (item.kind !== 'op' || category(item.op) !== 'search') continue;
    const op = item.op;
    const args = op.call?.args ?? op.result?.args;
    const query = args?.query;
    if (query === undefined || query === null || query === '') {
      fb.notEvaluable('R002', 'search without query');
      continue;
    }
    const key = stableStringify({ tool: op.call?.tool_name ?? op.result?.tool_name, query, scope: args?.scope ?? null, flags: args?.flags ?? null });
    history = history.filter((h) => op.callIndex - h.op.callIndex < cfg.window_calls);
    history.push({ op, key });
    const act = active.get(key);
    if (act && op.callIndex - act.last < cfg.window_calls) {
      extend(act.finding, op);
      act.last = op.callIndex;
      continue;
    }
    const matches = history.filter((h) => h.key === key);
    if (matches.length >= cfg.min_repeats) {
      const allHashed = matches.every((m) => m.op.result?.content_hash);
      const sameResult = allHashed && new Set(matches.map((m) => m.op.result?.content_hash)).size === 1;
      const limitations = ['Identical queries may be intentional re-checks.'];
      if (!allHashed) limitations.push('Result hash missing for some calls; results may have differed.');
      else if (!sameResult) limitations.push('Result hashes differ between calls; underlying data may have changed.');
      const finding = fb.add(g, {
        rule: 'R002',
        title: 'Repeated identical search',
        subject: redactText(String(typeof query === 'string' ? query : stableStringify(query))).slice(0, 160),
        occurrences: 0,
        event_ids: [],
        source_refs: [],
        confidence: sameResult ? 'high' : allHashed ? 'low' : 'medium',
        causality: 'n/a',
        limitations,
        suggestion: 'Reuse the earlier result, or narrow the scope/pattern instead of repeating the same search.',
      });
      for (const m of matches) extend(finding, m.op);
      active.set(key, { finding, last: op.callIndex });
    }
  }
}

function r003(g: StreamGroup, cfg: RuleConfig['R003'], fb: FindingBuilder) {
  let streak: { op: Op; key: string }[] = [];
  let current: Finding | undefined;
  const reset = () => {
    streak = [];
    current = undefined;
  };
  for (const item of g.timeline) {
    if (item.kind === 'user_message' || item.kind === 'file_change') {
      reset();
      continue;
    }
    if (item.kind !== 'op') continue;
    const op = item.op;
    const cat = category(op);
    if (cat === 'read' || cat === 'search') continue;
    if (cat !== 'shell') {
      // edit or unknown tool: may have fixed the environment
      reset();
      continue;
    }
    const args = op.call?.args ?? op.result?.args;
    const command = args?.command;
    if (typeof command !== 'string' || !op.result) {
      fb.notEvaluable('R003', typeof command !== 'string' ? 'shell call without command' : 'shell call without result');
      reset();
      continue;
    }
    const kind = op.result.error_kind ?? (op.result.exit_code === 127 ? 'command_not_found' : undefined);
    const key = `${String(args?.cwd ?? '')}\u0000${command}`;
    if (!kind || !ENV_ERRORS.has(kind)) {
      // success, network error, flaky test, test failure, other: not an env-failure retry
      reset();
      continue;
    }
    if (streak.length && streak[streak.length - 1]!.key !== key) reset();
    streak = streak.filter((s) => op.callIndex - s.op.callIndex < cfg.window_calls);
    streak.push({ op, key });
    if (current) {
      extend(current, op);
    } else if (streak.length >= cfg.min_repeats) {
      current = fb.add(g, {
        rule: 'R003',
        title: 'Retrying a command that fails for an environment reason',
        subject: redactText(command).slice(0, 160),
        occurrences: 0,
        event_ids: [],
        source_refs: [],
        confidence: op.result.error_kind ? 'high' : 'medium',
        causality: 'n/a',
        limitations: [
          args?.cwd ? 'Grouped by cwd and command.' : 'cwd not recorded; grouped by command within one stream.',
          'Environment changes made outside observed tools cannot be seen.',
        ],
        suggestion: `Check the prerequisite (e.g. is the executable installed / on PATH?) before retrying; error kind: ${kind}.`,
      });
      for (const s of streak) extend(current, s.op);
    }
  }
}

function r004(g: StreamGroup, cfg: RuleConfig['R004'], fb: FindingBuilder) {
  const artifacts = new Map<string, Op>();
  for (const item of g.timeline) {
    if (item.kind !== 'op') continue;
    const op = item.op;
    const produced = op.result?.artifact_id;
    if (produced) artifacts.set(produced, op);
    const expanded = op.call?.expanded_from_artifact_id ?? op.result?.expanded_from_artifact_id;
    if (!expanded) continue;
    const origin = artifacts.get(expanded);
    if (!origin) {
      fb.notEvaluable('R004', 'expansion of an artifact not produced in this stream/epoch');
      continue;
    }
    if (op.callIndex - origin.callIndex > cfg.window_calls) continue;
    const f = fb.add(g, {
      rule: 'R004',
      title: 'Compressed output expanded shortly after',
      subject: redactText(expanded),
      occurrences: 0,
      event_ids: [],
      source_refs: [],
      confidence: 'high',
      causality: 'unproven',
      limitations: [
        'The expansion event is certain; whether compression caused extra work is unproven.',
        'Expansion can be the intended, correct behaviour when omitted detail is needed.',
      ],
      suggestion: `Review what the view omitted for policy ${op.result?.policy_id ?? origin.result?.policy_id ?? '(unknown)'}; frequent early expansion argues against that policy.`,
    });
    extend(f, origin);
    extend(f, op);
  }
}

export function runRules(events: CanonicalEvent[], cfg: RuleConfig = DEFAULT_RULE_CONFIG, projectRoot?: string): RuleOutput {
  const groups = groupStreams(events);
  const fb = new FindingBuilder(projectRoot);
  for (const g of groups) {
    r001(g, cfg.R001, fb);
    r002(g, cfg.R002, fb);
    r003(g, cfg.R003, fb);
    r004(g, cfg.R004, fb);
  }
  return { findings: fb.findings, not_evaluable: fb.notEvaluableList, streams_analysed: groups.length };
}
