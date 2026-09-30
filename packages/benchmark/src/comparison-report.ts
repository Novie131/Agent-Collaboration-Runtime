import type { CompareReport } from './compare.js';
import { mdInline } from '@acr/security/redact.js';

const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : Math.round(x).toLocaleString('en-US'));
const tick = (p: boolean | null) => (p === null ? '— (not evaluable)' : p ? 'pass' : '**FAIL**');

export function renderComparisonMarkdown(r: CompareReport): string {
  const out: string[] = [];
  out.push(`# Agent Efficiency — comparison \`${mdInline(r.experiment_id)}\``, '');
  if (r.synthetic) out.push('> **SYNTHETIC DATA.** This report exercises the comparison pipeline; it is not evidence of token savings.', '');
  out.push(`**Primary verdict: \`${r.primary_verdict}\`**`, '');
  for (const s of r.statements) out.push(`- ${mdInline(s, 400)}`);
  out.push('');

  out.push('## Scope', '');
  out.push(`- Policy: \`${mdInline(r.scope.policy.id)}\` ${mdInline(r.scope.policy.hash)}`);
  out.push(`- Host: ${mdInline(r.scope.settings.host.name)} ${mdInline(r.scope.settings.host.version)} · model ${mdInline(r.scope.settings.model.id)} · reasoning effort ${mdInline(r.scope.settings.model.reasoning_effort)}`);
  out.push(`- Task set: ${r.scope.train_tasks} train + ${r.scope.holdout_tasks} holdout · digest ${mdInline(r.scope.task_set_digest)}`);
  out.push(`- Stats plan registered ${mdInline(r.stats_plan.registered_at)}: success = ${r.stats_plan.success_method}, tokens = ${r.stats_plan.token_method} (${r.stats_plan.bootstrap_iterations} iterations, seed ${r.stats_plan.seed})`, '');

  if (r.setup_problems.length) {
    out.push('## Setup problems', '');
    for (const p of r.setup_problems) out.push(`- ${mdInline(p, 300)}`);
    out.push('');
  }

  for (const c of r.comparisons) {
    out.push(`## ${mdInline(c.label)} (${c.baseline} vs ${c.treatment}) — \`${c.verdict}\``, '');
    for (const reason of c.verdict_reasons) out.push(`- ${mdInline(reason, 400)}`);
    out.push('', '| Gate | Result | Detail |', '| --- | --- | --- |');
    for (const g of c.gates) out.push(`| ${mdInline(g.gate)} | ${tick(g.passed)} | ${mdInline(g.detail, 300)} |`);
    out.push('');
    out.push('### Quality', '');
    out.push(`- Valid pairs: ${c.pairs.length}; excluded (infrastructure-invalid): ${c.excluded_pairs.length}; unpaired runs: ${c.unpaired_runs.length}`);
    out.push(`- Success rate: baseline ${pct(c.quality.baseline_success_rate)}, treatment ${pct(c.quality.treatment_success_rate)}, observed Δ ${c.quality.observed_delta === null ? 'n/a' : `${(c.quality.observed_delta * 100).toFixed(1)} pp`}`);
    if (c.quality.success_ci) out.push(`- One-sided 95% lower bound for Δ: ${(c.quality.success_ci.lower_bound * 100).toFixed(1)} pp (discordant: +${c.quality.success_ci.treatment_only_pass} / −${c.quality.success_ci.baseline_only_pass})`);
    else out.push(`- Success interval: not reported — ${mdInline(c.quality.success_ci_unavailable_reason ?? '', 300)}`);
    for (const d of c.quality.rubric) out.push(`- Rubric ${mdInline(d.dimension)}: ${d.baseline_mean?.toFixed(2) ?? 'n/a'} → ${d.treatment_mean?.toFixed(2) ?? 'n/a'}${d.decreased ? ' **(decreased)**' : ''}`);
    out.push('');
    out.push('### Whole-task tokens (T_task)', '');
    out.push(`- Usage completeness: ${c.tokens.completeness}${c.tokens.incomplete_runs.length ? ` (incomplete: ${c.tokens.incomplete_runs.map((x) => mdInline(x)).join(', ')})` : ''}`);
    out.push(`- Σ T_task: baseline ${num(c.tokens.baseline_total)}, treatment ${num(c.tokens.treatment_total)}`);
    out.push(`- Observed token reduction: ${pct(c.tokens.observed_token_reduction)}`);
    out.push(`- Median per-task relative change: ${pct(c.tokens.median_task_relative_change)}`);
    if (c.tokens.per_task_distribution) {
      const d = c.tokens.per_task_distribution;
      out.push(`- Per-task relative change distribution: min ${pct(d.min)}, p25 ${pct(d.p25)}, median ${pct(d.median)}, p75 ${pct(d.p75)}, max ${pct(d.max)}`);
    }
    out.push(c.tokens.ci ? `- One-sided 95% lower bound of reduction: ${pct(c.tokens.ci.lower_bound)}` : `- Token interval: not reported — ${mdInline(c.tokens.ci_unavailable_reason ?? '', 300)}`);
    out.push(`- Tokens per successful run: baseline ${num(c.tokens.tokens_per_success.baseline)}, treatment ${num(c.tokens.tokens_per_success.treatment)}`);
    if (c.tokens.per_task.length) {
      out.push('', '| Task | Baseline mean | Treatment mean | Change |', '| --- | --- | --- | --- |');
      for (const t of c.tokens.per_task) out.push(`| ${mdInline(t.task_id)} | ${num(t.baseline_mean)} | ${num(t.treatment_mean)} | ${pct(t.relative_change)} |`);
    }
    out.push('');
    out.push('### Reported separately (not T_task)', '');
    out.push(`- Tool output bytes: baseline ${num(c.secondary.tool_output_bytes.baseline)}, treatment ${num(c.secondary.tool_output_bytes.treatment)}`);
    out.push(`- Cost${c.secondary.cost.currency ? ` (${mdInline(c.secondary.cost.currency)})` : ''}: baseline ${c.secondary.cost.baseline ?? 'n/a'}, treatment ${c.secondary.cost.treatment ?? 'n/a'} — ${mdInline(c.secondary.cost.note, 200)}`);
    out.push(`- Duration (ms): baseline ${num(c.secondary.duration_ms.baseline)}, treatment ${num(c.secondary.duration_ms.treatment)}`);
    if (c.secondary.adoption) out.push(`- Adoption: wrapper used in ${c.secondary.adoption.treatment_runs_with_wrapper}/${c.secondary.adoption.treatment_runs} treatment runs; ${c.secondary.adoption.expand_invocations} expand call(s)`);
    else out.push('- Adoption: not recorded (cannot assume the Skill/wrapper was actually used)');
    out.push('');
  }

  out.push('## Runs', '', '| Run | Task | Group | Rep | Pass | T_task | Notes |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const o of r.runs) {
    out.push(`| ${mdInline(o.run_id)} | ${mdInline(o.task_id)} | ${o.group} | ${o.repetition} | ${o.invalid ? 'invalid' : o.pass ? 'yes' : 'no'} | ${o.t_task === null ? `n/a (${o.usage_completeness})` : num(o.t_task)} | ${mdInline(o.fail_reasons.join('; '), 160)} |`);
  }
  out.push('');
  return out.join('\n');
}
