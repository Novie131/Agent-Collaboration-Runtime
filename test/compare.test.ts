import { describe, expect, it } from 'vitest';
import { compareExperiment } from '@acr/benchmark/compare.js';
import { clusterBootstrapReduction, tangoLowerBound, tangoScore } from '@acr/benchmark/stats.js';
import { ExperimentManifest } from '@acr/benchmark/evaluation.js';
import { experiment, runRec, task } from './helpers/experiment.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

describe('Tango score lower bound', () => {
  it('all concordant successes: non-zero-width interval, lower bound below 0', () => {
    const b = tangoLowerBound(Array.from({ length: 10 }, () => ({ baseline: true, treatment: true })))!;
    expect(b.observed_delta).toBe(0);
    // closed form for x12 = x21 = 0: |Δ| = z² / (n + z²)
    const z2 = 1.6448536269514722 ** 2;
    expect(b.lower_bound).toBeCloseTo(-z2 / (10 + z2), 4);
    expect(b.lower_bound).toBeLessThan(0);
  });

  it('bound moves up with more discordant wins for treatment and stays ≤ observed', () => {
    const pairs = [
      ...Array.from({ length: 30 }, () => ({ baseline: true, treatment: true })),
      ...Array.from({ length: 8 }, () => ({ baseline: false, treatment: true })),
      ...Array.from({ length: 1 }, () => ({ baseline: true, treatment: false })),
    ];
    const b = tangoLowerBound(pairs)!;
    expect(b.lower_bound).toBeLessThan(b.observed_delta);
    expect(b.lower_bound).toBeGreaterThan(0);
    expect(tangoScore(8, 1, 39, b.lower_bound)).toBeCloseTo(1.6448536269514722, 3);
  });
});

describe('cluster bootstrap', () => {
  it('is deterministic for a seed and needs at least two tasks', () => {
    const tasks = ids(10).map((t, i) => ({ task_id: t, baseline_mean: 1000 + i * 10, treatment_mean: 900 + i * 10 }));
    const a = clusterBootstrapReduction(tasks, 2000, 1)!;
    const b = clusterBootstrapReduction(tasks, 2000, 1)!;
    expect(a.lower_bound).toBe(b.lower_bound);
    expect(a.lower_bound).toBeGreaterThan(0);
    expect(clusterBootstrapReduction(tasks.slice(0, 1), 2000, 1)).toBeNull();
  });
});

describe('compare verdicts', () => {
  it('tokens down but success rate down → regressed', () => {
    const t = ids(10);
    const runs = t.flatMap((id, i) => [runRec(id, 'A0', 1, { tokens: 1000 }), runRec(id, 'B', 1, { tokens: 500, pass: i !== 0 })]);
    const r = compareExperiment(experiment(t.map((x) => task(x)), runs));
    expect(r.primary_verdict).toBe('regressed');
    expect(r.comparisons[0]!.tokens.observed_token_reduction).toBeCloseTo(0.5);
  });

  it('bytes down but T_task up → not validated (no_gain or inconclusive)', () => {
    const t = ids(10);
    const runs = t.flatMap((id) => [
      { ...runRec(id, 'A0', 1, { tokens: 1000 }), tool_output_bytes: 50_000 },
      { ...runRec(id, 'B', 1, { tokens: 1100 }), tool_output_bytes: 5_000 },
    ]);
    const r = compareExperiment(experiment(t.map((x) => task(x)), runs));
    expect(['no_gain', 'inconclusive']).toContain(r.primary_verdict);
    expect(r.comparisons[0]!.secondary.tool_output_bytes).toEqual({ baseline: 500_000, treatment: 50_000 });
    expect(r.comparisons[0]!.tokens.observed_token_reduction).toBeLessThan(0);
  });

  it('small all-success sample → inconclusive, never a zero-width guarantee', () => {
    const t = ids(10);
    const runs = t.flatMap((id) => [runRec(id, 'A0', 1, { tokens: 1000 }), runRec(id, 'B', 1, { tokens: 800 })]);
    const r = compareExperiment(experiment(t.map((x) => task(x)), runs));
    const c = r.comparisons[0]!;
    expect(r.primary_verdict).toBe('inconclusive');
    expect(c.quality.success_ci!.lower_bound).toBeLessThan(0);
  });

  it('repeated runs per task: no success interval is invented', () => {
    const t = ids(10);
    const runs = t.flatMap((id) => [1, 2, 3].flatMap((rep) => [runRec(id, 'A0', rep), runRec(id, 'B', rep, { tokens: 800 })]));
    const c = compareExperiment(experiment(t.map((x) => task(x)), runs)).comparisons[0]!;
    expect(c.quality.success_ci).toBeNull();
    expect(c.quality.success_ci_unavailable_reason).toMatch(/clustered/);
    expect(c.verdict).toBe('inconclusive');
  });

  it('incomplete usage → inconclusive, not zero', () => {
    const t = ids(10);
    const runs = t.flatMap((id, i) => [runRec(id, 'A0', 1), runRec(id, 'B', 1, { tokens: i === 3 ? null : 800 })]);
    const c = compareExperiment(experiment(t.map((x) => task(x)), runs)).comparisons[0]!;
    expect(c.tokens.completeness).toBe('incomplete');
    expect(c.tokens.observed_token_reduction).toBeNull();
    expect(c.verdict).toBe('inconclusive');
  });

  it('zero baseline tokens → reduction not computable', () => {
    const runs = [runRec('t1', 'A0', 1, { tokens: 0 }), runRec('t1', 'B', 1, { tokens: 0 })];
    const c = compareExperiment(experiment([task('t1')], runs)).comparisons[0]!;
    expect(c.tokens.observed_token_reduction).toBeNull();
  });

  it('rubric decrease or confirmed regression → regressed', () => {
    const t = ids(3);
    const rubricDown = t.flatMap((id) => [runRec(id, 'A0', 1, { rubric: 4 }), runRec(id, 'B', 1, { rubric: 3 })]);
    expect(compareExperiment(experiment(t.map((x) => task(x)), rubricDown)).primary_verdict).toBe('regressed');
    const confirmed = t.flatMap((id, i) => [runRec(id, 'A0', 1), runRec(id, 'B', 1, { confirmed: i === 0 })]);
    expect(compareExperiment(experiment(t.map((x) => task(x)), confirmed)).primary_verdict).toBe('regressed');
  });

  it('failed safety fixtures → regressed', () => {
    const runs = [runRec('t1', 'A0', 1), runRec('t1', 'B', 1)];
    const r = compareExperiment(experiment([task('t1')], runs, { safety_fixtures: { suite_digest: 'x', passed: false, failures: ['secret leaked'] } }));
    expect(r.primary_verdict).toBe('regressed');
  });

  it('excludes infrastructure-invalid pairs but keeps a wrapper crash as a failure', () => {
    const runs = [
      runRec('t1', 'A0', 1),
      runRec('t1', 'B', 1, { invalid: true }),
      runRec('t2', 'A0', 1),
      { ...runRec('t2', 'B', 1, { invalid: true }), wrapper_crashed: true },
    ];
    const r = compareExperiment(experiment([task('t1'), task('t2')], runs));
    const c = r.comparisons[0]!;
    expect(c.excluded_pairs.map((p) => p.task_id)).toEqual(['t1']);
    expect(c.quality.treatment_success_rate).toBe(0);
    expect(r.primary_verdict).toBe('regressed');
  });

  it('changed model settings in one run → inconclusive with a setup problem', () => {
    const runs = [runRec('t1', 'A0', 1), { ...runRec('t1', 'B', 1), settings: { ...runRec('t1', 'B', 1).settings, model: { id: 'model-x', reasoning_effort: 'low' } } }];
    const r = compareExperiment(experiment([task('t1')], runs));
    expect(r.setup_problems.join(' ')).toMatch(/settings differ/);
    expect(r.primary_verdict).toBe('inconclusive');
  });

  it('can reach validated_for_scope only when every gate passes', () => {
    // 40 tasks, one run each; treatment wins 10 discordant pairs → success lower bound ≥ 0; 20% fewer tokens.
    const t = ids(40);
    const runs = t.flatMap((id, i) => [runRec(id, 'A0', 1, { tokens: 1000 + i * 37, pass: i >= 10 }), runRec(id, 'B', 1, { tokens: Math.round((1000 + i * 37) * 0.8) })]);
    const r = compareExperiment(experiment(t.map((x) => task(x)), runs));
    const c = r.comparisons[0]!;
    expect(c.gates.every((g) => g.passed === true)).toBe(true);
    expect(r.primary_verdict).toBe('validated_for_scope');
    expect(r.statements.join(' ')).toMatch(/SYNTHETIC/);
  });

  it('the shipped synthetic example validates against the schema', async () => {
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(new URL('../examples/experiment.synthetic.json', import.meta.url), 'utf8'));
    const parsed = ExperimentManifest.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(compareExperiment(parsed.data!).synthetic).toBe(true);
  });
});
