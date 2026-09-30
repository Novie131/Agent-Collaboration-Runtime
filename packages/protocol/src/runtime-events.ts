import { z } from 'zod';
import { Actor } from './collaboration.js';

/**
 * RuntimeEvent: an append-only record of what happened to tasks in the hub (SPEC §24).
 * Distinct from TranscriptEvent (transcript-events.ts), which is parsed from an agent's own session log.
 */
export const RuntimeEventType = z.enum([
  'TASK_CREATED',
  'TASK_CLAIMED',
  'TASK_BLOCKED',
  'RESULT_SUBMITTED',
  'VERIFICATION_COMPLETED',
  'REVIEW_SUBMITTED',
  'REVIEW_RESPONDED',
  'CONTEXT_REQUESTED',
  'CONTEXT_FULFILLED',
  'DECISION_RECORDED',
  'LIMIT_EXCEEDED',
  'TASK_ESCALATED',
  'TASK_RESOLVED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'TASK_CANCELLED',
  'GUARD_OVERRIDDEN',
  'TOOL_CALLED',
  'SESSION_REPORTED',
]);
export type RuntimeEventType = z.infer<typeof RuntimeEventType>;

export const RuntimeEvent = z.object({
  id: z.number().int(),
  task_id: z.string().nullable(),
  type: RuntimeEventType,
  actor: Actor,
  timestamp: z.string(),
  payload: z.record(z.unknown()),
});
export type RuntimeEvent = z.infer<typeof RuntimeEvent>;

export const Endpoint = z.enum(['remote', 'local', 'cli']);
export type Endpoint = z.infer<typeof Endpoint>;

/** Size record for every tool call; the raw data for the ChatGPT tool I/O estimate (SPEC §29.2). */
export const ToolCallRecord = z.object({
  endpoint: Endpoint,
  tool: z.string(),
  task_id: z.string().nullable(),
  request_tokens: z.number().int().nonnegative(),
  response_tokens: z.number().int().nonnegative(),
  ok: z.boolean(),
  estimator: z.string(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;
