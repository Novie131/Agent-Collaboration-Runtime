import { createHash } from 'node:crypto';
import { summarizeUsage } from '../observe/usage.js';
import type { UsageEvent } from '../schema/events.js';
import { INFRA_INVALID, type ExperimentManifest, type RunRecord, type Settings } from '../schema/evaluation.js';
import { clusterBootstrapReduction, median, quantile, tangoLowerBound, type BootstrapResult, type PairedBinaryBound } from './stats.js';

export type Verdict = 'regressed' | 'inconclusive' | 'no_gain' | 'validated_for_scope';

export interface RunOutcome {
  run_id: string;
  task_id: string;
  group: RunRecord['group'];
  repetition: number;
  pass: boolean;
  invalid: boolean;
  fail_reasons: string[];
  t_task: number | null;
  usage_completeness: 'complete' | 'incomplete' | 'not_evaluable';
}

export interface ComparisonResult {
  label: string;
  baseline: string;
  treatment: string;
  pairs: { task_id: string; repetition: number; baseline_run: string; treatment_run: string }[];
  excluded_pairs: { task_id: string; repetition: number; reason: string }[];
  unpaired_runs: string[];
  quality: {
    baseline_success_rate: number | null;
    treatment_success_rate: number | null;
    observed_delta: number | null;
    success_ci: PairedBinaryBound | null;
    success_ci_unavailable_reason: string | null;
    rubric: { dimension: string; baseline_mean: number | null; treatment_mean: number | null; decreased: boolean }[];
    confirmed_regressions: string[];
  };
  tokens: {
    completeness: 'complete' | 'incomplete';
    incomplete_runs: string[];
    baseline_total: number | null;
    treatment_total: number | null;
    observed_token_reduction: number | null;
    per_task: { task_id: string; baseline_mean: number; treatment_mean: number; relative_change: number | null }[];
    median_task_relative_change: number | null;
    per_task_distribution: { min: number; p25: number; median: number; p75: number; max: number } | null;
    ci: BootstrapResult | null;
    ci_unavailable_reason: string | null;
    tokens_per_success: { baseline: number | null; treatment: number | null };
  };
  secondary: {
    tool_output_bytes: { baseline: number | null; treatment: number | null };
    cost: { baseline: number | null; treatment: number | null; currency: string | null; note: string };
    duration_ms: { baseline: number | null; treatment: number | null };
    adoption: { treatment_runs_with_wrapper: number; treatment_runs: number; expand_invocations: number } | null;
  };
  gates: { gate: string; passed: boolean | null; detail: string }[];
  verdict: Verdict;
  verdict_reasons: string[];
}

export interface CompareReport {
  report_type: 'agent-efficiency/comparison';
  report_version: 1;
  generated_at: string;
  experiment_id: string;
  synthetic: boolean;
  stats_plan: ExperimentManifest['stats_plan'];
  scope: {
    policy: ExperimentManifest['candidate_policy'];
    settings: Settings;
    task_set_digest: string;
    holdout_tasks: number;
    train_tasks: number;
  };
  setup_problems: string[];
  runs: RunOutcome[];
  comparisons: ComparisonResult[];
  primary_verdict: Verdict;
  statements: string[];
}

const stable = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
};
const digest = (v: unknown) => `sha256:${createHash('sha256').update(stable(v)).digest('hex')}`;

function outcome(run: RunRecord): RunOutcome {
  const reasons: string[] = [];
  const v = run.verifier;
  const infraInvalid = v.status === 'invalid' && !!v.invalid_category && (INFRA_INVALID as readonly string[]).includes(v.invalid_category) && !run.wrapper_crashed;
  if (v.status === 'invalid' && !infraInvalid) reasons.push('invalid without an infrastructure category (or wrapper crash) counts as failure');
  if (v.status === 'fail') reasons.push('verifier failed');
  if (v.hard_checks.some((c) => !c.passed)) reasons.push(`hard checks failed: ${v.hard_checks.filter((c) => !c.passed).map((c) => c.name).join(', ')}`);
  if (!v.requirement_complete) reasons.push('requirement not fully completed');
  if (v.tests_skipped_or_deleted) reasons.push('tests skipped or deleted to avoid failure');
  if (v.false_completion_claim) reasons.push('agent claimed completion falsely');
  if (run.timed_out) reasons.push('timed out');
  if (run.wrapper_crashed) reasons.push('wrapper crashed');
  if (!v.hard_checks.length) reasons.push('no hard checks recorded; cannot be verified');

  let t: number | null = null;
  let completeness: RunOutcome['usage_completeness'] = 'not_evaluable';
  if (run.usage) {
    const events = run.usage.requests.map(
      (u, i) =>
        ({
          schema_version: 2,
          id: `${run.run_id}:u${i}`,
          task_id: run.task_id,
          run_id: run.run_id,
          session_id: run.run_id,
          stream_id: 'run',
          sequence: i,
          source_ref: { input_id: run.run_id, line: i + 1 },
          type: 'usage',
          usage: u,
        }) as UsageEvent,
    );
    const s = summarizeUsage(events, run.usage.gaps ?? [], (run.usage.gaps ?? []).length > 0);
    t = s.t_task;
    completeness = s.completeness;
  }
  return {
    run_id: run.run_id,
    task_id: run.task_id,
    group: run.group,
    repetition: run.repetition,
    pass: !infraInvalid && reasons.length === 0 && v.status === 'pass',
    invalid: infraInvalid,
    fail_reasons: infraInvalid ? [`invalid (${v.invalid_category}): ${v.invalid_reason ?? 'no reason given'}`] : reasons,
    t_task: t,
    usage_completeness: completeness,
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function compareGroups(exp: ExperimentManifest, outcomes: Map<string, RunOutcome>, runs: RunRecord[], cmp: ExperimentManifest['comparisons'][number]): ComparisonResult {
  const plan = exp.stats_plan;
  const pairs: ComparisonResult['pairs'] = [];
  const excluded: ComparisonResult['excluded_pairs'] = [];
  const unpaired: string[] = [];
  const byKey = (g: string) => {
    const m = new Map<string, RunRecord>();
    for (const r of runs.filter((x) => x.group === g)) m.set(`${r.task_id}\u0000${r.repetition}`, r);
    return m;
  };
  const base = byKey(cmp.baseline);
  const treat = byKey(cmp.treatment);
  for (const [k, b] of base) {
    const t = treat.get(k);
    if (!t) {
      unpaired.push(b.run_id);
      continue;
    }
    const ob = outcomes.get(b.run_id)!;
    const ot = outcomes.get(t.run_id)!;
    if (ob.invalid || ot.invalid) {
      excluded.push({ task_id: b.task_id, repetition: b.repetition, reason: `infrastructure-invalid run(s): ${[ob, ot].filter((o) => o.invalid).map((o) => o.run_id).join(', ')}` });
      continue;
    }
    pairs.push({ task_id: b.task_id, repetition: b.repetition, baseline_run: b.run_id, treatment_run: t.run_id });
  }
  for (const [k, t] of treat) if (!base.has(k)) unpaired.push(t.run_id);

  const pb = pairs.map((p) => outcomes.get(p.baseline_run)!);
  const pt = pairs.map((p) => outcomes.get(p.treatment_run)!);
  const rate = (os: RunOutcome[]) => (os.length ? os.filter((o) => o.pass).length / os.length : null);

  // success CI: Tango needs independent pairs -> exactly one valid pair per task
  const tasksInPairs = new Set(pairs.map((p) => p.task_id));
  let successCi: PairedBinaryBound | null = null;
  let successCiReason: string | null = null;
  if (!pairs.length) successCiReason = 'no valid pairs';
  else if (tasksInPairs.size !== pairs.length) {
    successCiReason = 'repeated runs per task are clustered; no reliable clustered paired-binary method is implemented, so no interval is reported';
  } else {
    successCi = tangoLowerBound(pairs.map((_, i) => ({ baseline: pb[i]!.pass, treatment: pt[i]!.pass })));
  }

  // rubric
  const dims = new Set(exp.tasks.flatMap((t) => t.acceptance.rubric_dimensions));
  const runById = new Map(runs.map((r) => [r.run_id, r]));
  const rubric = [...dims].map((d) => {
    const vals = (ids: string[]) => ids.map((id) => runById.get(id)?.verifier.rubric?.[d]).filter((x): x is number => typeof x === 'number');
    const bm = mean(vals(pairs.map((p) => p.baseline_run)));
    const tm = mean(vals(pairs.map((p) => p.treatment_run)));
    return { dimension: d, baseline_mean: bm, treatment_mean: tm, decreased: bm !== null && tm !== null && tm < bm };
  });
  const confirmed = pairs.map((p) => runById.get(p.treatment_run)!).filter((r) => r.regression_confirmed).map((r) => r.run_id);

  // tokens
  const incompleteRuns = [...pb, ...pt].filter((o) => o.t_task === null).map((o) => o.run_id);
  const tokenComplete = incompleteRuns.length === 0 && pairs.length > 0;
  const perTaskMap = new Map<string, { b: number[]; t: number[] }>();
  if (tokenComplete) {
    pairs.forEach((p, i) => {
      const e = perTaskMap.get(p.task_id) ?? { b: [], t: [] };
      e.b.push(pb[i]!.t_task!);
      e.t.push(pt[i]!.t_task!);
      perTaskMap.set(p.task_id, e);
    });
  }
  const perTask = [...perTaskMap.entries()].map(([task_id, e]) => {
    const bm = mean(e.b)!;
    const tm = mean(e.t)!;
    return { task_id, baseline_mean: bm, treatment_mean: tm, relative_change: bm > 0 ? tm / bm - 1 : null };
  });
  const bTotal = tokenComplete ? sum(pb.map((o) => o.t_task!)) : null;
  const tTotal = tokenComplete ? sum(pt.map((o) => o.t_task!)) : null;
  const reduction = bTotal !== null && tTotal !== null && bTotal > 0 ? 1 - tTotal / bTotal : null;
  const rel = perTask.map((x) => x.relative_change).filter((x): x is number => x !== null).sort((a, b) => a - b);
  let ci: BootstrapResult | null = null;
  let ciReason: string | null = null;
  if (!tokenComplete) ciReason = 'usage incomplete for some runs';
  else if (perTask.length < plan.min_tasks_for_token_ci) ciReason = `only ${perTask.length} task(s); plan requires ${plan.min_tasks_for_token_ci}`;
  else {
    ci = clusterBootstrapReduction(perTask.map((x) => ({ task_id: x.task_id, baseline_mean: x.baseline_mean, treatment_mean: x.treatment_mean })), plan.bootstrap_iterations, plan.seed);
    if (!ci) ciReason = 'bootstrap could not be computed';
    else if (ci.skipped_resamples > 0) ciReason = `${ci.skipped_resamples} resample(s) had zero baseline tokens`;
  }
  const successes = (os: RunOutcome[]) => os.filter((o) => o.pass).length;
  const perSuccess = (total: number | null, os: RunOutcome[]) => (total !== null && successes(os) > 0 ? total / successes(os) : null);

  // secondary metrics, shown separately and never merged into T_task
  const sec = (ids: string[], f: (r: RunRecord) => number | undefined) => {
    const vals = ids.map((id) => f(runById.get(id)!));
    return vals.every((v) => v !== undefined) && vals.length ? sum(vals as number[]) : null;
  };
  const bIds = pairs.map((p) => p.baseline_run);
  const tIds = pairs.map((p) => p.treatment_run);
  const currencies = new Set([...bIds, ...tIds].map((id) => runById.get(id)!.cost?.currency).filter(Boolean));
  const treatRuns = tIds.map((id) => runById.get(id)!);
  const adoptionKnown = treatRuns.every((r) => r.adoption);

  // gates and verdict
  const gates: ComparisonResult['gates'] = [];
  const reasons: string[] = [];
  const safety = exp.safety_fixtures;
  gates.push({ gate: '1 safety/integrity fixtures', passed: safety ? safety.passed : null, detail: safety ? (safety.passed ? `suite ${safety.suite_digest}` : safety.failures.join('; ')) : 'not provided' });
  const rubricDown = rubric.filter((r) => r.decreased).map((r) => r.dimension);
  const observedDelta = pairs.length ? rate(pt)! - rate(pb)! : null;
  gates.push({
    gate: '2 no confirmed quality regression / rubric decrease',
    passed: confirmed.length === 0 && rubricDown.length === 0 && (observedDelta === null || observedDelta >= 0),
    detail: [
      confirmed.length ? `confirmed regressions: ${confirmed.join(', ')}` : '',
      rubricDown.length ? `rubric decreased: ${rubricDown.join(', ')}` : '',
      observedDelta !== null && observedDelta < 0 ? `observed success rate fell by ${(-observedDelta * 100).toFixed(1)} pp` : '',
    ].filter(Boolean).join('; ') || 'none observed',
  });
  gates.push({
    gate: '3 success-rate Δ one-sided 95% lower bound ≥ 0',
    passed: successCi ? successCi.lower_bound >= 0 : null,
    detail: successCi ? `Δ=${successCi.observed_delta.toFixed(3)}, lower bound ${successCi.lower_bound.toFixed(3)} (Tango score, n=${successCi.n_pairs})` : (successCiReason ?? ''),
  });
  gates.push({
    gate: '4 task-token reduction one-sided 95% lower bound > 0',
    passed: ci && !ciReason ? ci.lower_bound > 0 : null,
    detail: ci && !ciReason ? `lower bound ${(ci.lower_bound * 100).toFixed(1)}% (task-cluster bootstrap, ${ci.iterations} iterations, seed ${plan.seed})` : (ciReason ?? ''),
  });
  gates.push({
    gate: `5 observed token reduction ≥ ${(plan.min_token_gain * 100).toFixed(0)}% (design threshold)`,
    passed: reduction === null ? null : reduction >= plan.min_token_gain,
    detail: reduction === null ? 'not computable' : `${(reduction * 100).toFixed(1)}%`,
  });

  let verdict: Verdict;
  const g = gates.map((x) => x.passed);
  if (g[0] === false || g[1] === false) {
    verdict = 'regressed';
    reasons.push('quality or safety gate failed; the policy must not be recommended');
  } else if (g.some((x) => x === null)) {
    verdict = 'inconclusive';
    reasons.push(...gates.filter((x) => x.passed === null).map((x) => `${x.gate}: ${x.detail}`));
  } else if (g[2] === false) {
    verdict = 'inconclusive';
    reasons.push('success-rate lower bound below 0: non-inferiority not shown with this sample');
  } else if (g[3] === false || g[4] === false) {
    verdict = 'no_gain';
    reasons.push('quality gate passed but there is not enough evidence of whole-task token reduction');
  } else {
    verdict = 'validated_for_scope';
    reasons.push('all gates passed for this evaluation scope only');
  }

  return {
    label: cmp.label,
    baseline: cmp.baseline,
    treatment: cmp.treatment,
    pairs,
    excluded_pairs: excluded,
    unpaired_runs: unpaired,
    quality: {
      baseline_success_rate: rate(pb),
      treatment_success_rate: rate(pt),
      observed_delta: observedDelta,
      success_ci: successCi,
      success_ci_unavailable_reason: successCiReason,
      rubric,
      confirmed_regressions: confirmed,
    },
    tokens: {
      completeness: tokenComplete ? 'complete' : 'incomplete',
      incomplete_runs: incompleteRuns,
      baseline_total: bTotal,
      treatment_total: tTotal,
      observed_token_reduction: reduction,
      per_task: perTask,
      median_task_relative_change: median(rel),
      per_task_distribution: rel.length
        ? { min: rel[0]!, p25: quantile(rel, 0.25), median: quantile(rel, 0.5), p75: quantile(rel, 0.75), max: rel[rel.length - 1]! }
        : null,
      ci: ciReason ? null : ci,
      ci_unavailable_reason: ciReason,
      tokens_per_success: { baseline: perSuccess(bTotal, pb), treatment: perSuccess(tTotal, pt) },
    },
    secondary: {
      tool_output_bytes: { baseline: sec(bIds, (r) => r.tool_output_bytes), treatment: sec(tIds, (r) => r.tool_output_bytes) },
      cost: {
        baseline: currencies.size <= 1 ? sec(bIds, (r) => r.cost?.amount) : null,
        treatment: currencies.size <= 1 ? sec(tIds, (r) => r.cost?.amount) : null,
        currency: currencies.size === 1 ? String([...currencies][0]) : null,
        note: 'Cost is reported separately; lower cost without lower tokens does not meet the goal.',
      },
      duration_ms: { baseline: sec(bIds, (r) => r.duration_ms), treatment: sec(tIds, (r) => r.duration_ms) },
      adoption: adoptionKnown && treatRuns.length
        ? {
            treatment_runs_with_wrapper: treatRuns.filter((r) => r.adoption!.wrapper_invocations > 0).length,
            treatment_runs: treatRuns.length,
            expand_invocations: sum(treatRuns.map((r) => r.adoption!.expand_invocations)),
          }
        : null,
    },
    gates,
    verdict,
    verdict_reasons: reasons,
  };
}

const settingsEqual = (a: Settings, b: Settings) => stable(a) === stable(b);

export function compareExperiment(exp: ExperimentManifest, now = new Date()): CompareReport {
  const problems: string[] = [];
  const taskIds = new Set(exp.tasks.map((t) => t.task_id));
  if (taskIds.size !== exp.tasks.length) problems.push('duplicate task_id in tasks');
  const runIds = new Set<string>();
  for (const r of exp.runs) {
    if (runIds.has(r.run_id)) problems.push(`duplicate run_id ${r.run_id}`);
    runIds.add(r.run_id);
    if (!taskIds.has(r.task_id)) problems.push(`run ${r.run_id} references unknown task ${r.task_id}`);
    if (!settingsEqual(r.settings, exp.fixed_settings)) problems.push(`run ${r.run_id} settings differ from fixed_settings (model/effort/agent/permissions must not change)`);
    if (r.group === 'B' && (!r.policy || r.policy.id !== exp.candidate_policy.id || r.policy.hash !== exp.candidate_policy.hash)) {
      problems.push(`run ${r.run_id} (B) did not use the candidate policy ${exp.candidate_policy.id}`);
    }
    if (r.group !== 'B' && r.policy) problems.push(`run ${r.run_id} (${r.group}) must not use a policy`);
  }
  const holdout = exp.tasks.filter((t) => t.split === 'holdout').length;
  const outcomes = new Map(exp.runs.map((r) => [r.run_id, outcome(r)]));
  const comparisons = exp.comparisons.map((c) => compareGroups(exp, outcomes, exp.runs, c));
  if (problems.length) {
    for (const c of comparisons) {
      if (c.verdict !== 'regressed') {
        c.verdict = 'inconclusive';
        c.verdict_reasons.unshift('experiment setup problems (see setup_problems)');
      }
    }
  }
  const primary = comparisons[0]!;
  const statements = [
    'Engineering completion and proven token savings are separate states; this report covers only the latter, for the stated scope.',
    exp.synthetic ? 'SYNTHETIC DATA: this comparison demonstrates the pipeline and is not a measurement of savings.' : 'Measured data as recorded in the run manifests.',
    'Finite tests cannot prove that future tasks will not regress; "validated_for_scope" is limited to this policy hash, host, model settings and task set.',
    'Bytes, provider tokens, cost and duration are reported separately; byte reduction is not token or cost reduction.',
  ];
  if (primary.verdict !== 'validated_for_scope') statements.push(`No savings claim should be made from this experiment (verdict: ${primary.verdict}).`);
  if (holdout === 0) statements.push('No holdout tasks: results may be tuned to the evaluation set.');

  return {
    report_type: 'agent-efficiency/comparison',
    report_version: 1,
    generated_at: now.toISOString(),
    experiment_id: exp.experiment_id,
    synthetic: exp.synthetic,
    stats_plan: exp.stats_plan,
    scope: {
      policy: exp.candidate_policy,
      settings: exp.fixed_settings,
      task_set_digest: digest(exp.tasks),
      holdout_tasks: holdout,
      train_tasks: exp.tasks.length - holdout,
    },
    setup_problems: problems,
    runs: [...outcomes.values()],
    comparisons,
    primary_verdict: primary.verdict,
    statements,
  };
}
