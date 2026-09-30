import { z } from 'zod';

/**
 * Collaboration payloads exchanged through the hub (SPEC §15). Inputs are what the
 * assistants send; records are what the hub stores and returns. Every stored record
 * carries `version`; inputs may omit it (defaults to 1) so tool calls stay short.
 */

export const PROTOCOL_VERSION = 1 as const;
const version = z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION);

const text = (max: number) => z.string().trim().min(1).max(max);
/** Repository-relative path using forward slashes; no absolute paths, no `..` segments. */
export const RepoPath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .transform((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''))
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p), 'must be relative to the workspace root')
  .refine((p) => !p.split('/').includes('..'), 'must not contain ".."');
/** `path/to/file.ts` or `path/to/file.ts:12-40`. */
export const EvidenceRef = text(1100);

export const Risk = z.enum(['low', 'medium', 'high']);
export type Risk = z.infer<typeof Risk>;
export const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export const TaskType = z.enum(['implementation', 'bugfix', 'refactor', 'investigation', 'docs']);
export type TaskType = z.infer<typeof TaskType>;

export const TaskState = z.enum([
  'READY',
  'CLAIMED',
  'BLOCKED',
  'IMPLEMENTED',
  'CHANGES_REQUESTED',
  'ESCALATED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export type TaskState = z.infer<typeof TaskState>;
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export const Actor = z.enum(['chatgpt', 'claude', 'human', 'hub']);
export type Actor = z.infer<typeof Actor>;

// ---------------------------------------------------------------- task

export const TaskInput = z
  .object({
    version,
    title: text(200),
    type: TaskType.default('implementation'),
    risk: Risk,
    goal: text(4000),
    scope: z.object({ paths: z.array(RepoPath).min(1).max(50) }).strict(),
    constraints: z.array(text(500)).max(30).default([]),
    acceptance: z.array(text(500)).min(1).max(30),
    context_refs: z.array(text(40)).max(30).default([]),
  })
  .strict();
export type TaskInput = z.infer<typeof TaskInput>;

export const Task = TaskInput.extend({
  id: z.string(),
  state: TaskState,
  /** Risk requested by ChatGPT; `risk` is the effective value after hub minimum rules. */
  requested_risk: Risk,
  risk_reasons: z.array(z.string()).default([]),
  base_commit: z.string().nullable(),
  /** Working-tree state at the latest claim; hub-internal, never sent to ChatGPT. */
  claim_snapshot: z.object({ head: z.string().nullable(), dirty: z.record(z.string().nullable()) }).nullable(),
  claimed_at: z.string().nullable(),
  blocked: z.object({ reason: z.string(), question: z.string(), at: z.string() }).nullable(),
  claims: z.number().int().nonnegative(),
  review_rounds: z.number().int().nonnegative(),
  context_requests: z.number().int().nonnegative(),
  escalation_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Task = z.infer<typeof Task>;

// ---------------------------------------------------------------- result

export const ResultInput = z
  .object({
    version,
    status: z.enum(['completed', 'partial', 'blocked']),
    summary: text(2000),
    changes: z.array(z.object({ path: RepoPath, summary: text(500) }).strict()).max(200).default([]),
    tests: z
      .object({
        artifact: z.string().optional(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    decisions: z.array(text(500)).max(30).default([]),
    uncertainties: z.array(text(500)).max(30).default([]),
    review: z
      .object({ recommended: z.boolean(), focus: z.array(text(200)).max(20).default([]) })
      .strict()
      .default({ recommended: false, focus: [] }),
    evidence: z.array(EvidenceRef).max(50).default([]),
  })
  .strict();
export type ResultInput = z.infer<typeof ResultInput>;

export const FindingCode = z.enum([
  'unclaimed_change',
  'claimed_but_unchanged',
  'out_of_scope_change',
  'tests_unverified',
  'test_count_mismatch',
  'test_failures',
  'risk_raised',
  'secret_file_changed',
  'git_unavailable',
]);
export type FindingCode = z.infer<typeof FindingCode>;

export const Finding = z.object({
  code: FindingCode,
  detail: z.string(),
  paths: z.array(z.string()).default([]),
  /** Mismatches block acceptance; notes are informational. */
  blocking: z.boolean(),
});
export type Finding = z.infer<typeof Finding>;

export const Verification = z.object({
  verified_at: z.string(),
  base_commit: z.string().nullable(),
  changed_files: z.array(z.string()),
  diff_artifact: z.string().nullable(),
  tests: z.object({ passed: z.number(), failed: z.number(), artifact: z.string() }).nullable(),
  findings: z.array(Finding),
});
export type Verification = z.infer<typeof Verification>;

export const TaskResult = ResultInput.extend({
  id: z.string(),
  task_id: z.string(),
  round: z.number().int().positive(),
  submitted_at: z.string(),
  verification: Verification,
});
export type TaskResult = z.infer<typeof TaskResult>;

// ---------------------------------------------------------------- review

export const Severity = z.enum(['low', 'medium', 'high']);
export type Severity = z.infer<typeof Severity>;

export const ReviewCommentInput = z
  .object({
    claim: text(1000),
    reason: text(2000),
    severity: Severity,
    evidence: z.array(EvidenceRef).max(20).default([]),
    requested_action: z.enum(['inspect_and_respond', 'fix', 'explain']).default('inspect_and_respond'),
  })
  .strict();

export const ReviewInput = z
  .object({
    version,
    verdict: z.enum(['approve', 'changes_requested']),
    summary: text(2000).optional(),
    comments: z.array(ReviewCommentInput).max(30).default([]),
  })
  .strict()
  .refine((r) => r.verdict === 'approve' || r.comments.length > 0, 'changes_requested needs at least one comment');
export type ReviewInput = z.infer<typeof ReviewInput>;

export const ReviewComment = ReviewCommentInput.extend({
  id: z.string(),
  status: z.enum(['open', 'fixed', 'rejected', 'acknowledged']),
  response: z
    .object({ action: z.string().optional(), note: z.string().optional(), evidence: z.array(z.string()) })
    .nullable(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

export const Review = z.object({
  version: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  task_id: z.string(),
  round: z.number().int().positive(),
  verdict: z.enum(['approve', 'changes_requested']),
  summary: z.string().optional(),
  comments: z.array(ReviewComment),
  created_at: z.string(),
});
export type Review = z.infer<typeof Review>;

export const ReviewResponseInput = z
  .object({
    version,
    items: z
      .array(
        z
          .object({
            comment_id: z.string(),
            outcome: z.enum(['fixed', 'rejected', 'acknowledged']),
            action: text(500).optional(),
            note: text(2000).optional(),
            evidence: z.array(EvidenceRef).max(20).default([]),
          })
          .strict()
          .refine((i) => i.outcome !== 'rejected' || i.evidence.length > 0, 'a rejected comment must carry evidence'),
      )
      .min(1)
      .max(30),
  })
  .strict();
export type ReviewResponseInput = z.infer<typeof ReviewResponseInput>;

// ---------------------------------------------------------------- decisions

export const DecisionInput = z
  .object({
    version,
    task_id: z.string().optional(),
    title: text(200),
    reason: text(2000),
    evidence: z.array(EvidenceRef).max(20).default([]),
    tags: z.array(text(40)).max(10).default([]),
    supersedes: z.string().optional(),
  })
  .strict();
export type DecisionInput = z.infer<typeof DecisionInput>;

export const Decision = z.object({
  version: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  task_id: z.string().nullable(),
  title: z.string(),
  status: z.enum(['accepted', 'superseded']),
  reason: z.string(),
  evidence: z.array(z.string()),
  tags: z.array(z.string()),
  supersedes: z.string().nullable(),
  superseded_by: z.string().nullable(),
  created_by: Actor,
  created_at: z.string(),
});
export type Decision = z.infer<typeof Decision>;

// ---------------------------------------------------------------- context requests

export const ContextRequestInput = z
  .object({
    version,
    question: text(2000),
    paths: z.array(RepoPath).max(20).default([]),
  })
  .strict();
export type ContextRequestInput = z.infer<typeof ContextRequestInput>;

export const ContextRequest = z.object({
  id: z.string(),
  task_id: z.string(),
  question: z.string(),
  paths: z.array(z.string()),
  status: z.enum(['open', 'fulfilled']),
  answer: z.string().nullable(),
  answer_artifact: z.string().nullable(),
  created_at: z.string(),
  fulfilled_at: z.string().nullable(),
});
export type ContextRequest = z.infer<typeof ContextRequest>;

// ---------------------------------------------------------------- artifacts

export const ArtifactType = z.enum(['diff', 'test_output', 'file_snapshot', 'context_answer', 'log']);
export type ArtifactType = z.infer<typeof ArtifactType>;

export const ArtifactRef = z.object({
  id: z.string(),
  type: ArtifactType,
  ref: z.string(),
  lines: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  estimated_tokens: z.number().int().nonnegative(),
  sha256: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

// ---------------------------------------------------------------- envelope

/** Every tool response on both endpoints (SPEC §14.4). */
export type HubResponse<T> = {
  ok: boolean;
  data?: T;
  error?: { code: HubErrorCode; message: string };
  /** Suggested next step for the developer; advice only, never an automatic action. */
  next?: string;
  estimatedTokens: number;
  /** What the outgoing privacy guard masked in this response (counts only, never values). */
  privacy?: { masked: Record<string, number> };
  /** Advisory warnings, e.g. suspected prompt injection inside repository content. */
  warnings?: string[];
};

export type HubErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_STATE'
  | 'LIMIT_EXCEEDED'
  | 'OUT_OF_SCOPE'
  | 'DENIED'
  | 'GUARD_FAILED'
  | 'NO_TASK'
  | 'INTERNAL';
