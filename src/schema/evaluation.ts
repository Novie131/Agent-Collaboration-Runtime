import { z } from 'zod';
import { RequestUsage } from './events.js';

export const Settings = z
  .object({
    host: z.object({ name: z.string(), version: z.string() }).strict(),
    model: z.object({ id: z.string(), reasoning_effort: z.string() }).strict(),
    agent_version: z.string(),
    permissions: z.string(),
    max_task_minutes: z.number().positive(),
    stop_condition: z.string(),
    hardware: z.string(),
    dependencies_digest: z.string(),
  })
  .strict();
export type Settings = z.infer<typeof Settings>;

export const TaskManifest = z
  .object({
    task_id: z.string().min(1),
    defined_at: z.string(),
    requirement: z.string().min(1),
    base_commit: z.string().min(1),
    environment: z.record(z.string()),
    split: z.enum(['train', 'holdout']),
    acceptance: z
      .object({
        required_tests: z.array(z.string()).min(1),
        checks: z.array(z.object({ name: z.string(), applicable: z.boolean(), reason: z.string().optional() }).strict()),
        compatibility: z.array(z.string()),
        security: z.array(z.string()),
        prohibited_changes: z.array(z.string()),
        rubric_dimensions: z.array(z.string()),
      })
      .strict(),
    verifier: z.string().min(1),
  })
  .strict();
export type TaskManifest = z.infer<typeof TaskManifest>;

export const INFRA_INVALID = ['verifier_infrastructure', 'host_infrastructure', 'provider_outage'] as const;

export const RunRecord = z
  .object({
    run_id: z.string().min(1),
    task_id: z.string().min(1),
    group: z.enum(['A0', 'A1', 'B']),
    repetition: z.number().int().positive(),
    settings: Settings,
    policy: z.object({ id: z.string(), hash: z.string() }).strict().nullable(),
    cache_state: z.enum(['warm', 'cold', 'unknown']),
    started_at: z.string(),
    ended_at: z.string().optional(),
    timed_out: z.boolean(),
    verifier: z
      .object({
        status: z.enum(['pass', 'fail', 'invalid']),
        hard_checks: z.array(z.object({ name: z.string(), passed: z.boolean() }).strict()),
        requirement_complete: z.boolean(),
        tests_skipped_or_deleted: z.boolean(),
        false_completion_claim: z.boolean().optional(),
        invalid_category: z.enum(INFRA_INVALID).optional(),
        invalid_reason: z.string().optional(),
        rubric: z.record(z.number()).optional(),
      })
      .strict(),
    /** Set when reproduction confirmed that the candidate policy caused a failure. */
    regression_confirmed: z.boolean().optional(),
    wrapper_crashed: z.boolean().optional(),
    usage: z
      .object({
        requests: z.array(RequestUsage),
        gaps: z.array(z.string()).optional(),
      })
      .strict()
      .nullable(),
    tool_output_bytes: z.number().int().nonnegative().optional(),
    cost: z
      .object({ amount: z.number().nonnegative(), currency: z.string(), source: z.enum(['provider_reported', 'price_sheet']), price_date: z.string().optional() })
      .strict()
      .optional(),
    duration_ms: z.number().nonnegative().optional(),
    adoption: z.object({ wrapper_invocations: z.number().int().nonnegative(), expand_invocations: z.number().int().nonnegative() }).strict().optional(),
  })
  .strict();
export type RunRecord = z.infer<typeof RunRecord>;

export const StatsPlan = z
  .object({
    registered_at: z.string(),
    alpha_one_sided: z.literal(0.05),
    success_method: z.literal('tango_score_paired'),
    token_method: z.literal('task_cluster_bootstrap_percentile'),
    bootstrap_iterations: z.number().int().min(1000),
    seed: z.number().int(),
    min_tasks_for_token_ci: z.number().int().min(2),
    min_token_gain: z.number().min(0).max(1),
  })
  .strict();
export type StatsPlan = z.infer<typeof StatsPlan>;

export const ExperimentManifest = z
  .object({
    experiment_type: z.literal('agent-efficiency/experiment'),
    experiment_version: z.literal(1),
    experiment_id: z.string().min(1),
    synthetic: z.boolean(),
    description: z.string(),
    comparisons: z
      .array(z.object({ baseline: z.enum(['A0', 'A1']), treatment: z.literal('B'), label: z.string() }).strict())
      .min(1),
    fixed_settings: Settings,
    candidate_policy: z.object({ id: z.string(), hash: z.string() }).strict(),
    stats_plan: StatsPlan,
    safety_fixtures: z
      .object({ suite_digest: z.string(), passed: z.boolean(), failures: z.array(z.string()) })
      .strict()
      .nullable(),
    tasks: z.array(TaskManifest).min(1),
    runs: z.array(RunRecord).min(1),
  })
  .strict();
export type ExperimentManifest = z.infer<typeof ExperimentManifest>;
