import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { ADAPTERS } from '@acr/transcripts/index.js';
import { InvalidInputError } from '@acr/transcripts/types.js';
import { DEFAULT_MAX_LINE_BYTES } from '@acr/transcripts/jsonl.js';
import { buildAnalysisReport, renderAnalysisMarkdown, type AnalysisReport } from './analysis-report.js';
import { writeReportFiles } from '@acr/platform/write.js';
import type { UsageEvent } from '@acr/protocol/transcript-events.js';
import { TOOL_VERSION } from '@acr/platform/version.js';
import { DEFAULT_RULE_CONFIG, RuleConfig, runRules } from './rules.js';
import { summarizeUsage } from '@acr/transcripts/usage.js';

export const AnalyzeConfig = z
  .object({
    rules: z
      .object({
        R001: RuleConfig.shape.R001.partial().optional(),
        R002: RuleConfig.shape.R002.partial().optional(),
        R003: RuleConfig.shape.R003.partial().optional(),
        R004: RuleConfig.shape.R004.partial().optional(),
      })
      .strict()
      .optional(),
    max_line_bytes: z.number().int().positive().optional(),
    project_root: z.string().optional(),
  })
  .strict();

export interface AnalyzeOptions {
  input: string;
  adapter: string;
  outDir: string;
  strict: boolean;
  overwrite: boolean;
  configPath?: string;
  maxLineBytes?: number;
  projectRoot?: string;
  now?: () => Date;
}

/** Config is plain JSON; it is parsed, never executed. */
export async function loadAnalyzeConfig(path: string): Promise<z.infer<typeof AnalyzeConfig>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new InvalidInputError(`config ${basename(path)}: ${(err as Error).message}`);
  }
  const parsed = AnalyzeConfig.safeParse(raw);
  if (!parsed.success) throw new InvalidInputError(`config ${basename(path)}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data;
}

export async function analyze(opts: AnalyzeOptions): Promise<{ report: AnalysisReport; written: string[] }> {
  const adapter = ADAPTERS[opts.adapter];
  if (!adapter) throw new InvalidInputError(`unknown or unsupported adapter "${opts.adapter}" (see: acr adapters)`);
  const st = await stat(opts.input);
  if (!st.isFile()) throw new InvalidInputError(`${opts.input} is not a file`);

  const config = opts.configPath ? await loadAnalyzeConfig(opts.configPath) : {};
  const ruleConfig = RuleConfig.parse({
    R001: { ...DEFAULT_RULE_CONFIG.R001, ...config.rules?.R001 },
    R002: { ...DEFAULT_RULE_CONFIG.R002, ...config.rules?.R002 },
    R003: { ...DEFAULT_RULE_CONFIG.R003, ...config.rules?.R003 },
    R004: { ...DEFAULT_RULE_CONFIG.R004, ...config.rules?.R004 },
  });
  const inputId = basename(opts.input);
  const parsed = await adapter.parse(opts.input, {
    strict: opts.strict,
    maxLineBytes: opts.maxLineBytes ?? config.max_line_bytes ?? DEFAULT_MAX_LINE_BYTES,
    inputId,
  });

  const projectRoot = opts.projectRoot ?? config.project_root;
  const rules = runRules(parsed.events, ruleConfig, projectRoot);
  const usageEvents = parsed.events.filter((e): e is UsageEvent => e.type === 'usage');
  const unobserved = parsed.unobservedRequests ?? [];
  const gaps = unobserved.map((u) => `not in the input: ${u}`);
  const knownMissing = unobserved.length > 0;
  if (adapter.info.id === 'claude-code') gaps.push('sub-agent transcripts stored in separate files are not included');
  if (parsed.coverage.partial) gaps.push('input partially parsed; skipped lines may contain usage');
  const usage = summarizeUsage(usageEvents, gaps, knownMissing || parsed.coverage.partial);

  const report = buildAnalysisReport({
    generated_at: (opts.now ?? (() => new Date()))().toISOString(),
    tool_version: TOOL_VERSION,
    input: { input_id: inputId, adapter: adapter.info.id, adapter_status: adapter.info.status, strict: opts.strict },
    coverage: parsed.coverage,
    adapter_warnings: parsed.warnings,
    rule_config: ruleConfig,
    streams_analysed: rules.streams_analysed,
    findings: rules.findings,
    not_evaluable: rules.not_evaluable,
    usage,
  });
  const written = await writeReportFiles(
    opts.outDir,
    { 'analysis.json': `${JSON.stringify(report, null, 2)}\n`, 'analysis.md': renderAnalysisMarkdown(report) },
    opts.overwrite,
  );
  return { report, written };
}
