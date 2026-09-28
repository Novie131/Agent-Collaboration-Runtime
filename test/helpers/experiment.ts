import type { ExperimentManifest, RunRecord, Settings, TaskManifest } from '../../src/schema/evaluation.js';

export const SETTINGS: Settings = {
  host: { name: 'claude-code', version: '0.0.0-synthetic' },
  model: { id: 'model-x', reasoning_effort: 'high' },
  agent_version: 'synthetic',
  permissions: 'default',
  max_task_minutes: 30,
  stop_condition: 'agent reports done or time limit',
  hardware: 'synthetic',
  dependencies_digest: 'sha256:deps',
};

export const POLICY = { id: 'jest-v1', hash: 'sha256:policy' };

export function task(id: string, split: TaskManifest['split'] = 'holdout'): TaskManifest {
  return {
    task_id: id,
    defined_at: '2026-09-01T00:00:00Z',
    requirement: `synthetic requirement ${id}`,
    base_commit: 'abc123',
    environment: { node: '22' },
    split,
    acceptance: {
      required_tests: ['test/regression.test.js'],
      checks: [{ name: 'typecheck', applicable: true }, { name: 'build', applicable: false, reason: 'library has no build' }],
      compatibility: ['public API unchanged'],
      security: ['no secrets in logs'],
      prohibited_changes: ['do not edit tests'],
      rubric_dimensions: ['maintainability'],
    },
    verifier: 'external: pnpm vitest run test/regression.test.js',
  };
}

function splitTokens(total: number) {
  const input_uncached = Math.round(total * 0.1);
  const input_cache_read = Math.round(total * 0.8);
  const input_cache_write = Math.round(total * 0.05);
  const output_total = total - input_uncached - input_cache_read - input_cache_write;
  return { request_id: 'q', input_uncached, input_cache_read, input_cache_write, output_total, scope: 'request' as const, origin: 'provider_reported' as const, completeness: 'complete' as const };
}

export function runRec(taskId: string, group: RunRecord['group'], rep: number, opts: { pass?: boolean; tokens?: number | null; rubric?: number; invalid?: boolean; confirmed?: boolean } = {}): RunRecord {
  const pass = opts.pass ?? true;
  const tokens = opts.tokens === undefined ? 1000 : opts.tokens;
  return {
    run_id: `${taskId}-${group}-${rep}`,
    task_id: taskId,
    group,
    repetition: rep,
    settings: SETTINGS,
    policy: group === 'B' ? POLICY : null,
    cache_state: 'unknown',
    started_at: '2026-09-01T00:00:00Z',
    timed_out: false,
    verifier: {
      status: opts.invalid ? 'invalid' : pass ? 'pass' : 'fail',
      hard_checks: [{ name: 'regression test', passed: pass }],
      requirement_complete: pass,
      tests_skipped_or_deleted: false,
      ...(opts.invalid ? { invalid_category: 'verifier_infrastructure' as const, invalid_reason: 'verifier VM died' } : {}),
      rubric: { maintainability: opts.rubric ?? 4 },
    },
    ...(opts.confirmed ? { regression_confirmed: true } : {}),
    usage:
      tokens === null
        ? { requests: [{ request_id: 'q', scope: 'request', origin: 'provider_reported', completeness: 'incomplete', missing_fields: ['output_total'], input_uncached: 1 }] }
        : { requests: [splitTokens(tokens)] },
  };
}

export function experiment(tasks: TaskManifest[], runs: RunRecord[], extra: Partial<ExperimentManifest> = {}): ExperimentManifest {
  return {
    experiment_type: 'agent-efficiency/experiment',
    experiment_version: 1,
    experiment_id: 'synthetic',
    synthetic: true,
    description: 'test',
    comparisons: [{ baseline: 'A0', treatment: 'B', label: 'end-to-end' }],
    fixed_settings: SETTINGS,
    candidate_policy: POLICY,
    stats_plan: {
      registered_at: '2026-09-01T00:00:00Z',
      alpha_one_sided: 0.05,
      success_method: 'tango_score_paired',
      token_method: 'task_cluster_bootstrap_percentile',
      bootstrap_iterations: 2000,
      seed: 7,
      min_tasks_for_token_ci: 10,
      min_token_gain: 0.05,
    },
    safety_fixtures: { suite_digest: 'sha256:fixtures', passed: true, failures: [] },
    tasks,
    runs,
    ...extra,
  };
}
