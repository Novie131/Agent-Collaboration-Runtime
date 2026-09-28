import { relative, sep } from 'node:path';
import { isPendingLike, type JestAssertion, type ParsedJestResult } from './jest-result.js';
import { classifyStderr, type StderrClassification } from './stderr-classify.js';

export const RENDERER_ID = 'jest-view';
export const RENDERER_VERSION = '1.0.0';

export interface ViewProcessInfo {
  cwdDisplay: string;
  commandDisplay: string;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: string | null;
  wrapperExitCode: number;
}

export interface ViewInput {
  result: ParsedJestResult;
  stdout: string;
  stderr: string;
  rootDir: string;
  jsonPath: string;
  process: ViewProcessInfo;
  artifactId: string;
  runDirDisplay: string;
  policy: { id: string; status: string };
}

export interface OmittedItem {
  kind: string;
  count: number;
  expand: string;
}

export interface JestView {
  text: string;
  omitted: OmittedItem[];
  stderr: StderrClassification;
  /** Failed assertions whose details were not found in the suite message and were added from failureMessages. */
  failuresAddedFromRaw: number;
}

const rel = (root: string, p: string) => relative(root, p).split(sep).join('/') || p;
const fullTitle = (a: JestAssertion) => [...a.ancestorTitles, a.title].join(' › ');

function countsLine(label: string, parts: [string, number][], total: number) {
  const shown = parts.filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
  return `${label} ${[...shown, `${total} total`].join(', ')}`;
}

export function renderJestView(input: ViewInput): JestView {
  const { result: r, process: p } = input;
  const a = r.aggregated;
  const expandCmd = (part: string, raw = false) =>
    `agent-efficiency expand ${input.artifactId} --run-dir ${input.runDirDisplay} --part ${part}${raw ? ' --raw' : ''}`;
  const out: string[] = [];

  const exitDesc = p.signal ? `signal ${p.signal} (exit ${p.wrapperExitCode})` : `exit ${p.exitCode}`;
  const state = [
    p.timedOut ? 'TIMED OUT' : 'not timed out',
    ...(p.cancelled ? [`CANCELLED (${p.cancelled})`] : []),
    a.wasInterrupted ? 'run INCOMPLETE (interrupted)' : 'run complete',
  ].join(' · ');
  out.push(`[agent-efficiency ${input.policy.id} (${input.policy.status}) · selective view, not lossless · artifact ${input.artifactId}]`);
  out.push(`$ ${p.commandDisplay}  (cwd ${p.cwdDisplay} · started ${p.startedAt} · ${(p.durationMs / 1000).toFixed(2)}s · ${exitDesc} · ${state})`);
  const s = a.snapshot;
  const snapshotAny = s.total + s.unmatched + s.unchecked + s.added + s.updated + s.filesRemoved > 0 || s.failure;
  out.push(
    [
      countsLine(
        'Suites:',
        [
          [a.numRuntimeErrorTestSuites ? `failed (${a.numRuntimeErrorTestSuites} of them failed to run)` : 'failed', a.numFailedTestSuites],
          ['skipped', a.numPendingTestSuites],
          ['passed', a.numPassedTestSuites],
        ],
        a.numTotalTestSuites,
      ),
      countsLine('Tests:', [['failed', a.numFailedTests], ['skipped', a.numPendingTests], ['todo', a.numTodoTests], ['passed', a.numPassedTests]], a.numTotalTests),
      ...(snapshotAny
        ? [countsLine('Snapshots:', [['failed', s.unmatched], ['obsolete', s.unchecked], ['written', s.added], ['updated', s.updated], ['passed', s.matched], ['files removed', s.filesRemoved]], s.total) + (s.failure ? ' (snapshot failure)' : '')]
        : []),
    ].join(' · '),
  );
  if (a.openHandles.length) out.push(`Open handles reported: ${a.openHandles.length} (details, if any, are in stderr below)`);

  // Failures: every failed suite's formatted message verbatim (it names each failed
  // test with a ● header), plus raw messages for any failed test not found in it.
  const failedSuites = r.suites.filter((x) => x.status === 'failed');
  let failuresAddedFromRaw = 0;
  for (const suite of failedSuites) {
    out.push('', `FAIL ${rel(input.rootDir, suite.name)}`);
    out.push(suite.message.replace(/\n+$/, ''));
    for (const t of suite.assertions.filter((x) => x.status === 'failed')) {
      if (suite.message.includes(`● ${fullTitle(t)}`)) continue;
      failuresAddedFromRaw++;
      const loc = t.location ? `:${t.location.line}:${t.location.column}` : '';
      out.push(`  ● ${fullTitle(t)}${loc}   [not in the formatted suite message; raw failureMessages follow]`);
      for (const m of t.failureMessages ?? []) out.push(m);
    }
  }

  const notRun = r.suites.flatMap((x) =>
    x.assertions.filter((t) => isPendingLike(t.status) || t.status === 'todo').map((t) => ({ suite: x, t })),
  );
  if (notRun.length) {
    out.push('', `Skipped / todo (${notRun.length}):`);
    for (const { suite, t } of notRun) out.push(`  ${t.status === 'todo' ? '✎ todo' : `○ ${t.status}`} ${rel(input.rootDir, suite.name)} › ${fullTitle(t)}`);
  }
  const skippedSuites = r.suites.filter((x) => x.status === 'skipped' || x.status === 'pending');
  if (skippedSuites.length) {
    out.push('', `Skipped suites (${skippedSuites.length}):`);
    for (const x of skippedSuites) out.push(`  ${rel(input.rootDir, x.name)}`);
  }

  const cls = classifyStderr(input.stderr, r, input.rootDir, input.jsonPath);
  if (cls.retainedLineCount > 0) {
    out.push('', `--- stderr not recognised as reporter output (verbatim, ${cls.retainedLineCount} line(s)) ---`, cls.retainedText);
  }
  if (input.stdout.length > 0) {
    out.push('', '--- stdout (verbatim) ---', input.stdout.replace(/\n+$/, ''));
  }

  const passed = r.suites.flatMap((x) => x.assertions.filter((t) => t.status === 'passed'));
  const omitted: OmittedItem[] = [];
  if (passed.length) omitted.push({ kind: `names of ${passed.length} passed test(s)`, count: passed.length, expand: expandCmd('passed') });
  const reporterDup =
    cls.counts.suite_header + cls.counts.summary_verified + cls.counts.ran_all + cls.counts.results_written + cls.counts.verbose_test_line + cls.counts.verbose_describe_line;
  const stderrDup = [
    reporterDup ? `${reporterDup} reporter line(s) verified against the JSON result` : '',
    cls.duplicateFailureBlocks ? `${cls.duplicateFailureBlocks} failure block(s) identical to the messages above` : '',
  ].filter(Boolean);
  if (stderrDup.length) omitted.push({ kind: stderrDup.join('; '), count: reporterDup + cls.duplicateFailureBlocks, expand: expandCmd('stderr', true) });
  const failedCount = r.suites.reduce((n, x) => n + x.assertions.filter((t) => t.status === 'failed').length, 0);
  if (failedCount) omitted.push({ kind: 'raw failureMessages (unfiltered stacks) and failureDetails', count: failedCount, expand: expandCmd('failures') });
  omitted.push({ kind: 'per-test durations, full JSON result', count: 1, expand: expandCmd('result') });

  const partOf = (cmd: string) => cmd.slice(cmd.indexOf('--part ') + 7);
  out.push('', `Omitted (nothing re-run): agent-efficiency expand ${input.artifactId} --run-dir ${input.runDirDisplay} --part <part>`);
  for (const o of omitted) out.push(`  ${partOf(o.expand)}: ${o.kind}`);

  return { text: `${out.join('\n')}\n`, omitted, stderr: cls, failuresAddedFromRaw };
}
