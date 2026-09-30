import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { InvalidInputError } from '@acr/transcripts/types.js';
import { renderComparisonMarkdown } from './comparison-report.js';
import { writeReportFiles } from '@acr/platform/write.js';
import { ExperimentManifest } from './evaluation.js';
import { compareExperiment, type CompareReport } from './compare.js';

export async function runCompare(opts: { experiment: string; outDir: string; overwrite: boolean; now?: Date }): Promise<{ report: CompareReport; written: string[] }> {
  const text = await readFile(opts.experiment, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new InvalidInputError(`${basename(opts.experiment)}: ${(err as Error).message}`);
  }
  const parsed = ExperimentManifest.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new InvalidInputError(`${basename(opts.experiment)}: ${issues}`);
  }
  const report = compareExperiment(parsed.data, opts.now);
  const written = await writeReportFiles(
    opts.outDir,
    { 'comparison.json': `${JSON.stringify(report, null, 2)}\n`, 'comparison.md': renderComparisonMarkdown(report) },
    opts.overwrite,
  );
  return { report, written };
}
