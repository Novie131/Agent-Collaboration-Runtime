import { isAbsolute, join, relative, sep } from 'node:path';
import type { Writable } from 'node:stream';
import { displayPath, redact } from '@acr/security/redact.js';
import { parseJestResult } from '@acr/compression/jest-result.js';
import { ArtifactError, openRun, readVerifiedPart, writeNewFile } from './store.js';

export const EXPAND_PARTS = ['stdout', 'stderr', 'result', 'view', 'failures', 'passed', 'manifest'] as const;
export type ExpandPart = (typeof EXPAND_PARTS)[number];

export interface ExpandOptions {
  artifactId: string;
  runDir: string;
  part: ExpandPart;
  raw: boolean;
  stdout: Writable;
  stderr: Writable;
  projectRoot?: string;
}

const NOTICE_FILE = '.expand-notice-shown';

async function noticeOnce(runDirReal: string, stderr: Writable, message: string) {
  try {
    await writeNewFile(join(runDirReal, NOTICE_FILE), `${new Date().toISOString()}\n`);
    stderr.write(`[acr] ${message}\n`);
  } catch {
    // Already shown for this artifact (or the run-dir is read-only): stay quiet.
  }
}

function derive(part: 'failures' | 'passed', resultJson: string, root: string | undefined): string {
  const parsed = parseJestResult(resultJson);
  if (!parsed.ok) throw new ArtifactError(`stored Jest result cannot be parsed (${parsed.reason}: ${parsed.detail}); use --part result --raw`, 'io');
  const rel = (p: string) => {
    const base = root ?? process.cwd();
    const r = relative(base, p);
    return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : displayPath(p);
  };
  const out: string[] = [];
  for (const s of parsed.value.suites) {
    for (const a of s.assertions) {
      const name = [...a.ancestorTitles, a.title].join(' › ');
      if (part === 'passed' && a.status === 'passed') out.push(`✓ ${rel(s.name)} › ${name}${a.duration != null ? ` (${a.duration} ms)` : ''}`);
      if (part === 'failures' && a.status === 'failed') {
        out.push(`● ${rel(s.name)}${a.location ? `:${a.location.line}:${a.location.column}` : ''} › ${name}`);
        for (const m of a.failureMessages ?? []) out.push(m, '');
        if (a.failureDetails?.length) out.push('failureDetails:', JSON.stringify(a.failureDetails, null, 2), '');
      }
    }
    if (part === 'failures' && s.status === 'failed' && !s.assertions.some((a) => a.status === 'failed')) {
      out.push(`● ${rel(s.name)} (suite-level failure)`, s.message, '');
    }
  }
  if (!out.length) out.push(part === 'passed' ? '(no passed tests)' : '(no failures)');
  return `${out.join('\n')}\n`;
}

export async function expandArtifact(opts: ExpandOptions): Promise<void> {
  const run = await openRun(opts.runDir, opts.artifactId);
  let data: Buffer;
  switch (opts.part) {
    case 'manifest':
      data = Buffer.from(`${JSON.stringify(run.manifest, null, 2)}\n`);
      break;
    case 'failures':
    case 'passed': {
      const result = await readVerifiedPart(run, 'result');
      const root = opts.projectRoot;
      data = Buffer.from(derive(opts.part, result.toString('utf8'), root));
      break;
    }
    default:
      data = await readVerifiedPart(run, opts.part);
  }

  if (opts.raw) {
    opts.stdout.write(data);
    return;
  }
  const { text, redactions } = redact(data.toString('utf8'));
  opts.stdout.write(text);
  const n = Object.values(redactions).reduce((a, b) => a + b, 0);
  await noticeOnce(
    run.runDirReal,
    opts.stderr,
    `sanitized view${n ? ` (${n} value(s) masked)` : ''}; masking is best-effort, not complete protection. --raw returns the original bytes. This artifact describes a past run, not the current code.`,
  );
}
