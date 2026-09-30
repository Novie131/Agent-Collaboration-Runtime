import type { AdapterInfo, Coverage } from '@acr/transcripts/types.js';
import type { RuleConfig, RuleOutput } from './rules.js';
import type { UsageSummary } from '@acr/transcripts/usage.js';
import { mdCodeBlock, mdInline } from '@acr/security/redact.js';

export interface AnalysisReport {
  report_type: 'analysis';
  report_version: 1;
  generated_at: string;
  tool_version: string;
  input: { input_id: string; adapter: string; adapter_status: AdapterInfo['status']; strict: boolean };
  coverage: Coverage;
  adapter_warnings: string[];
  rule_config: RuleConfig;
  streams_analysed: number;
  findings: RuleOutput['findings'];
  not_evaluable: RuleOutput['not_evaluable'];
  usage: UsageSummary;
  disclaimers: string[];
}

const DISCLAIMERS = [
  'Findings are candidate waste, not proof; none of them blocks the agent.',
  'Report content is masked on a best-effort basis; masking is not complete protection.',
  'Token totals describe the observed log only; they are not a measure of savings.',
];

export function buildAnalysisReport(args: Omit<AnalysisReport, 'report_type' | 'report_version' | 'disclaimers'>): AnalysisReport {
  return { report_type: 'analysis', report_version: 1, ...args, disclaimers: DISCLAIMERS };
}

const n = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : x.toLocaleString('en-US'));

export function renderAnalysisMarkdown(r: AnalysisReport): string {
  const out: string[] = [];
  out.push('# Agent Efficiency — session analysis', '');
  out.push(`- Generated: ${mdInline(r.generated_at)} (acr ${mdInline(r.tool_version)})`);
  out.push(`- Input: \`${mdInline(r.input.input_id)}\` via adapter **${mdInline(r.input.adapter)}** (${r.input.adapter_status})${r.input.adapter_status !== 'supported' ? ' — results are not validated for this host' : ''}`);
  out.push(`- Coverage: ${r.coverage.parsed_lines} parsed, ${r.coverage.ignored_lines} ignored, ${r.coverage.skipped.length} skipped of ${r.coverage.total_lines} lines${r.coverage.partial ? ' — **PARTIAL**' : ''}`);
  out.push(`- Streams analysed: ${r.streams_analysed}`, '');

  if (r.coverage.skipped.length) {
    out.push('## Skipped lines', '');
    for (const s of r.coverage.skipped.slice(0, 50)) out.push(`- line ${s.line}: ${mdInline(s.reason)}`);
    if (r.coverage.skipped.length > 50) out.push(`- … ${r.coverage.skipped.length - 50} more (see JSON report)`);
    out.push('');
  }
  if (r.adapter_warnings.length) {
    out.push('## Adapter warnings', '');
    for (const w of r.adapter_warnings) out.push(`- ${mdInline(w, 400)}`);
    out.push('');
  }

  out.push('## Candidate waste findings', '');
  if (!r.findings.length) {
    out.push('No findings at the configured thresholds.', '');
  } else {
    out.push('| ID | Rule | Subject | Count | Confidence | Stream | Source lines |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const f of r.findings) {
      const lines = [...new Set(f.source_refs.map((s) => s.line))].slice(0, 8).join(', ');
      out.push(`| ${f.id} | ${f.rule} ${mdInline(f.title)} | ${mdInline(f.subject, 80)} | ${f.occurrences} | ${f.confidence}${f.causality === 'unproven' ? ' (causality unproven)' : ''} | ${mdInline(f.stream_id, 40)} | ${lines} |`);
    }
    out.push('');
    for (const f of r.findings) {
      out.push(`### ${f.id} — ${f.rule}`, '');
      out.push(`- Suggestion: ${mdInline(f.suggestion, 400)}`);
      for (const l of f.limitations) out.push(`- Limitation: ${mdInline(l, 400)}`);
      out.push(`- Event IDs: ${f.event_ids.slice(0, 12).map((e) => `\`${mdInline(e, 80)}\``).join(', ')}${f.event_ids.length > 12 ? ' …' : ''}`, '');
    }
  }

  if (r.not_evaluable.length) {
    out.push('## Not evaluable', '');
    for (const ne of r.not_evaluable) out.push(`- ${ne.rule}: ${mdInline(ne.reason)} × ${ne.count}`);
    out.push('');
  }

  out.push('## Token usage (observed)', '');
  const u = r.usage;
  out.push(`- Completeness: **${u.completeness}**`);
  out.push(`- Requests counted: ${u.requests_counted}${u.duplicate_request_ids.length ? ` (${u.duplicate_request_ids.length} duplicate ids counted once)` : ''}`);
  out.push(`- T_task: ${u.t_task === null ? 'not reported (usage incomplete or missing)' : n(u.t_task)}`);
  out.push(`- Observed (complete requests only): uncached ${n(u.observed_totals.input_uncached)}, cache read ${n(u.observed_totals.input_cache_read)}, cache write ${n(u.observed_totals.input_cache_write)}, output ${n(u.observed_totals.output_total)}`);
  for (const g of u.gaps) out.push(`- Gap: ${mdInline(g, 400)}`);
  out.push('');

  out.push('## Rule configuration', '', mdCodeBlock(JSON.stringify(r.rule_config, null, 2), 'json'), '');
  out.push('## Disclaimers', '');
  for (const d of r.disclaimers) out.push(`- ${d}`);
  out.push('');
  return out.join('\n');
}
