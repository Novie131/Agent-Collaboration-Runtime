import { z } from 'zod';

/**
 * Canonical event schema (schema_version 2). This is this project's own
 * contract, not any host's official transcript format.
 */

export const SourceRef = z
  .object({
    input_id: z.string().min(1),
    line: z.number().int().positive(),
    pointer: z.string().optional(),
  })
  .strict();
export type SourceRef = z.infer<typeof SourceRef>;

const eventBaseShape = {
  schema_version: z.literal(2),
  id: z.string().min(1),
  task_id: z.string().min(1),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  stream_id: z.string().min(1),
  context_epoch: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().optional(),
  source_ref: SourceRef,
};

export const ToolCategory = z.enum(['read', 'search', 'shell', 'edit', 'other']);
export type ToolCategory = z.infer<typeof ToolCategory>;

/**
 * Environment error classes a host adapter may attach to a tool_result.
 * Only the "environment" subset counts towards R003.
 */
export const ErrorKind = z.enum([
  'command_not_found',
  'missing_executable',
  'module_not_found',
  'permission_denied',
  'network',
  'flaky_test',
  'test_failure',
  'other',
]);
export type ErrorKind = z.infer<typeof ErrorKind>;

const toolObservationShape = {
  ...eventBaseShape,
  tool_call_id: z.string().min(1),
  category: ToolCategory,
  tool_name: z.string().min(1),
  content_hash: z.string().optional(),
  file_version_hash: z.string().optional(),
  path: z.string().optional(),
  range: z
    .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
    .strict()
    .optional(),
  args: z.record(z.unknown()).optional(),
  exit_code: z.number().int().optional(),
  signal: z.string().optional(),
  error_kind: ErrorKind.optional(),
  output_bytes: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  artifact_id: z.string().optional(),
  policy_id: z.string().optional(),
  expanded_from_artifact_id: z.string().optional(),
};

export const ToolCallEvent = z.object({ ...toolObservationShape, type: z.literal('tool_call') }).strict();
export const ToolResultEvent = z.object({ ...toolObservationShape, type: z.literal('tool_result') }).strict();

export const FileChangeEvent = z
  .object({
    ...eventBaseShape,
    type: z.literal('file_change'),
    path: z.string().min(1),
    tool_call_id: z.string().optional(),
    change: z.enum(['modified', 'created', 'deleted', 'renamed', 'unknown']).optional(),
  })
  .strict();

export const UserMessageEvent = z
  .object({
    ...eventBaseShape,
    type: z.literal('user_message'),
    /** Hash of the message text; the text itself is never required. */
    text_hash: z.string().optional(),
    /** false only when the adapter can tell this is not a new requirement (e.g. a tool approval). */
    new_requirement: z.boolean().optional(),
  })
  .strict();

export const ContextBoundaryEvent = z
  .object({
    ...eventBaseShape,
    type: z.literal('context_boundary'),
    kind: z.enum(['compaction', 'clear', 'resume', 'other']),
    next_epoch: z.string().optional(),
  })
  .strict();

const usageCounts = {
  input_uncached: z.number().int().nonnegative(),
  input_cache_read: z.number().int().nonnegative(),
  input_cache_write: z.number().int().nonnegative(),
  /** Includes reasoning when the provider counts it as output. Never add reasoning twice. */
  output_total: z.number().int().nonnegative(),
};
export const USAGE_FIELDS = ['input_uncached', 'input_cache_read', 'input_cache_write', 'output_total'] as const;
export type UsageField = (typeof USAGE_FIELDS)[number];

export const CompleteRequestUsage = z
  .object({
    request_id: z.string().min(1),
    ...usageCounts,
    reasoning_included_in_output: z.number().int().nonnegative().optional(),
    scope: z.literal('request'),
    origin: z.literal('provider_reported'),
    completeness: z.literal('complete').default('complete'),
  })
  .strict();
export type CompleteRequestUsage = z.infer<typeof CompleteRequestUsage>;

/** Partial usage: missing fields are recorded, never filled with zero. */
export const IncompleteRequestUsage = z
  .object({
    request_id: z.string().min(1),
    input_uncached: z.number().int().nonnegative().optional(),
    input_cache_read: z.number().int().nonnegative().optional(),
    input_cache_write: z.number().int().nonnegative().optional(),
    output_total: z.number().int().nonnegative().optional(),
    reasoning_included_in_output: z.number().int().nonnegative().optional(),
    scope: z.literal('request'),
    origin: z.literal('provider_reported'),
    completeness: z.literal('incomplete'),
    missing_fields: z.array(z.string()).min(1),
    note: z.string().optional(),
  })
  .strict();
export type IncompleteRequestUsage = z.infer<typeof IncompleteRequestUsage>;

export const RequestUsage = z.union([IncompleteRequestUsage, CompleteRequestUsage]);
export type RequestUsage = z.infer<typeof RequestUsage>;

export const UsageEvent = z
  .object({
    ...eventBaseShape,
    type: z.literal('usage'),
    usage: RequestUsage,
    /** Stream this request belongs to when it is a sub-agent request surfaced in a parent log. */
    parent_stream_id: z.string().optional(),
  })
  .strict();

export const SessionEndEvent = z
  .object({
    ...eventBaseShape,
    type: z.literal('session_end'),
    reason: z.string().optional(),
  })
  .strict();

export const CanonicalEvent = z.discriminatedUnion('type', [
  ToolCallEvent,
  ToolResultEvent,
  FileChangeEvent,
  UserMessageEvent,
  ContextBoundaryEvent,
  UsageEvent,
  SessionEndEvent,
]);
export type CanonicalEvent = z.infer<typeof CanonicalEvent>;
export type ToolCallEvent = z.infer<typeof ToolCallEvent>;
export type ToolResultEvent = z.infer<typeof ToolResultEvent>;
export type ToolObservation = ToolCallEvent | ToolResultEvent;
export type FileChangeEvent = z.infer<typeof FileChangeEvent>;
export type UserMessageEvent = z.infer<typeof UserMessageEvent>;
export type ContextBoundaryEvent = z.infer<typeof ContextBoundaryEvent>;
export type UsageEvent = z.infer<typeof UsageEvent>;
export type SessionEndEvent = z.infer<typeof SessionEndEvent>;
