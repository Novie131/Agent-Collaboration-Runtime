import type {
  ArtifactRef,
  ContextRequest,
  Decision,
  Review,
  ReviewComment,
  Task,
  TaskResult,
} from '@acr/protocol/collaboration.js';
import { estimateTokens } from '@acr/platform/tokens.js';

/**
 * Context Broker (SPEC §19): pure, deterministic builders for what each side receives.
 * Priority order follows §12.3; large content is never inlined, only referenced.
 */

/** Task fields ChatGPT sees. The claim snapshot and counters stay hub-internal. */
export function publicTask(t: Task) {
  return {
    id: t.id,
    title: t.title,
    type: t.type,
    state: t.state,
    risk: t.risk,
    ...(t.risk !== t.requested_risk ? { requested_risk: t.requested_risk, risk_reasons: t.risk_reasons } : {}),
    goal: t.goal,
    scope: t.scope,
    constraints: t.constraints,
    acceptance: t.acceptance,
    context_refs: t.context_refs,
    ...(t.blocked ? { blocked: t.blocked } : {}),
    ...(t.escalation_reason ? { escalation_reason: t.escalation_reason } : {}),
    rounds: { claims: t.claims, reviews: t.review_rounds, context_requests: t.context_requests },
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

export const openComments = (reviews: Review[]): (ReviewComment & { review_id: string })[] =>
  reviews.flatMap((r) => r.comments.filter((c) => c.status === 'open').map((c) => ({ ...c, review_id: r.id })));

/** Decisions relevant to a task: referenced by it, recorded for it, or tagged with one of its scope paths. */
export function relevantDecisions(task: Task, decisions: Decision[]): Decision[] {
  const refs = new Set(task.context_refs);
  return decisions.filter(
    (d) =>
      d.status === 'accepted' &&
      (refs.has(d.id) || d.task_id === task.id || d.tags.some((tag) => task.scope.paths.some((p) => p.startsWith(tag) || tag.startsWith(p)))),
  );
}

const compactDecision = (d: Decision) => ({ id: d.id, title: d.title, reason: d.reason });

/** What Claude receives from `get_task` (purpose: implement / respond). */
export function claudeTaskBundle(input: {
  task: Task;
  decisions: Decision[];
  reviews: Review[];
  contextRequests: ContextRequest[];
}) {
  const { task } = input;
  const comments = openComments(input.reviews);
  const openRequests = input.contextRequests.filter((c) => c.status === 'open');
  return {
    task: {
      id: task.id,
      title: task.title,
      type: task.type,
      state: task.state,
      risk: task.risk,
      goal: task.goal,
      scope: task.scope,
      constraints: task.constraints,
      acceptance: task.acceptance,
    },
    decisions: relevantDecisions(task, input.decisions).map(compactDecision),
    ...(comments.length
      ? {
          review_comments: comments.map((c) => ({
            review_id: c.review_id,
            comment_id: c.id,
            severity: c.severity,
            claim: c.claim,
            reason: c.reason,
            evidence: c.evidence,
            requested_action: c.requested_action,
          })),
        }
      : {}),
    ...(openRequests.length
      ? { context_requests: openRequests.map((c) => ({ id: c.id, question: c.question, paths: c.paths })) }
      : {}),
    ...(task.blocked ? { previously_blocked: task.blocked } : {}),
  };
}

export function diffStat(diff: string): { files: { path: string; added: number; removed: number }[]; added: number; removed: number } {
  const files: { path: string; added: number; removed: number }[] = [];
  let cur: { path: string; added: number; removed: number } | undefined;
  for (const line of diff.split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      cur = { path: m[2]!, added: 0, removed: 0 };
      files.push(cur);
      continue;
    }
    if (!cur || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
  }
  return { files, added: files.reduce((a, f) => a + f.added, 0), removed: files.reduce((a, f) => a + f.removed, 0) };
}

/** What ChatGPT receives from `get_result` (purpose: review). */
export function chatgptResultBundle(input: {
  task: Task;
  result: TaskResult;
  reviews: Review[];
  diff: { artifact: ArtifactRef; text: string } | null;
  testArtifact: ArtifactRef | null;
  acceptance: { allowed: boolean; blockers: string[] };
  inlineThresholdTokens: number;
}) {
  const { task, result } = input;
  const v = result.verification;
  const stat = input.diff ? diffStat(input.diff.text) : null;
  const diffInline = input.diff && input.diff.artifact.estimated_tokens <= input.inlineThresholdTokens;
  const comments = openComments(input.reviews);
  return {
    task: { id: task.id, title: task.title, state: task.state, risk: task.risk },
    result: {
      round: result.round,
      status: result.status,
      summary: result.summary,
      changes: result.changes,
      decisions: result.decisions,
      uncertainties: result.uncertainties,
      review: result.review,
      evidence: result.evidence,
    },
    verification: {
      ok: !v.findings.some((f) => f.blocking),
      findings: v.findings,
      changed_files: v.changed_files,
      tests: v.tests ?? (result.tests ? { claimed: result.tests, verified: false } : null),
    },
    diff: input.diff
      ? {
          artifact: input.diff.artifact.id,
          estimated_tokens: input.diff.artifact.estimated_tokens,
          stat,
          ...(diffInline ? { text: input.diff.text } : { how_to_read: 'get_diff with task_id and optional path/start/end' }),
        }
      : null,
    ...(input.testArtifact ? { test_output_artifact: { id: input.testArtifact.id, estimated_tokens: input.testArtifact.estimated_tokens } } : {}),
    ...(comments.length ? { open_review_comments: comments.map((c) => ({ id: c.id, severity: c.severity, claim: c.claim, status: c.status })) } : {}),
    acceptance: input.acceptance,
  };
}

/**
 * Cuts `lines` to fit `budgetTokens`, returning how far it got so the caller can offer the next
 * range. Never cuts silently: `truncated` and `next_start` tell the reader what is missing.
 */
export function fitLines(lines: string[], startLine: number, budgetTokens: number) {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const t = estimateTokens(line) + 1;
    if (out.length > 0 && used + t > budgetTokens) break;
    out.push(line);
    used += t;
  }
  const truncated = out.length < lines.length;
  return {
    text: out.join('\n'),
    end: startLine + out.length - 1,
    truncated,
    ...(truncated ? { next_start: startLine + out.length } : {}),
  };
}
