/**
 * Synthetic Jest --json results shaped after Jest 29's formatTestResults output.
 * Real captured output lives in fixtures/real/ and is tested separately.
 */

export interface SynthTest {
  title: string;
  ancestors?: string[];
  status: 'passed' | 'failed' | 'pending' | 'todo';
  failure?: string;
}

export interface SynthSuite {
  name: string;
  tests: SynthTest[];
  message?: string;
  execError?: boolean;
}

export const ROOT = '/work/proj';

export function failureBlock(t: SynthTest): string {
  const full = [...(t.ancestors ?? []), t.title].join(' › ');
  return `  ● ${full}\n\n    ${t.failure ?? 'Error'}\n\n      at Object.<anonymous> (src/x.test.js:3:5)\n`;
}

export function makeResult(suites: SynthSuite[], overrides: Record<string, unknown> = {}) {
  const testResults = suites.map((s) => {
    const failed = s.tests.filter((t) => t.status === 'failed');
    const message = s.message ?? (failed.length ? failed.map(failureBlock).join('\n') : '');
    return {
      assertionResults: s.tests.map((t) => ({
        ancestorTitles: t.ancestors ?? [],
        duration: t.status === 'passed' || t.status === 'failed' ? 1 : null,
        failureDetails: t.status === 'failed' ? [{}] : [],
        failureMessages: t.status === 'failed' ? [`Error: ${t.failure ?? 'Error'}\n    at Object.<anonymous> (${ROOT}/${s.name}:3:5)\n    at node_modules/jest-circus/build/utils.js:1:1`] : [],
        fullName: [...(t.ancestors ?? []), t.title].join(' '),
        invocations: 1,
        location: null,
        numPassingAsserts: 0,
        retryReasons: [],
        status: t.status,
        title: t.title,
      })),
      endTime: 2,
      message,
      name: `${ROOT}/${s.name}`,
      startTime: 1,
      status: failed.length || s.execError ? 'failed' : 'passed',
      summary: '',
    };
  });
  const all = suites.flatMap((s) => s.tests);
  const n = (st: string) => all.filter((t) => t.status === st).length;
  const failedSuites = testResults.filter((s) => s.status === 'failed').length;
  return {
    numFailedTestSuites: failedSuites,
    numFailedTests: n('failed'),
    numPassedTestSuites: testResults.length - failedSuites,
    numPassedTests: n('passed'),
    numPendingTestSuites: 0,
    numPendingTests: n('pending'),
    numRuntimeErrorTestSuites: suites.filter((s) => s.execError).length,
    numTodoTests: n('todo'),
    numTotalTestSuites: testResults.length,
    numTotalTests: all.length,
    openHandles: [],
    snapshot: { added: 0, didUpdate: false, failure: false, filesAdded: 0, filesRemoved: 0, filesRemovedList: [], filesUnmatched: 0, filesUpdated: 0, matched: 0, total: 0, unchecked: 0, uncheckedKeysByFile: [], unmatched: 0, updated: 0 },
    startTime: 1700000000000,
    success: failedSuites === 0,
    testResults,
    wasInterrupted: false,
    ...overrides,
  };
}

/** Default-reporter stderr for the result, as Jest prints it without colours. */
export function makeStderr(result: ReturnType<typeof makeResult>, opts: { verbose?: boolean; extra?: string; console?: string } = {}): string {
  const lines: string[] = [];
  for (const s of result.testResults) {
    const rel = s.name.slice(ROOT.length + 1);
    lines.push(`${s.status === 'failed' ? 'FAIL' : 'PASS'} ${rel}`);
    if (opts.console) lines.push(opts.console);
    if (opts.verbose) {
      for (const a of s.assertionResults) {
        const sym = a.status === 'passed' ? '✓' : a.status === 'failed' ? '✕' : a.status === 'todo' ? '✎' : '○';
        for (const anc of a.ancestorTitles) lines.push(`  ${anc}`);
        lines.push(`    ${sym} ${a.title}${a.duration ? ` (${a.duration} ms)` : ''}`);
      }
      lines.push('');
    }
    if (s.message) lines.push(s.message);
  }
  const r = result;
  const parts = (pairs: [string, number][], total: number) => [...pairs.filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`), `${total} total`].join(', ');
  lines.push(`Test Suites: ${parts([['failed', r.numFailedTestSuites], ['passed', r.numPassedTestSuites]], r.numTotalTestSuites)}`);
  lines.push(`Tests:       ${parts([['failed', r.numFailedTests], ['skipped', r.numPendingTests], ['todo', r.numTodoTests], ['passed', r.numPassedTests]], r.numTotalTests)}`);
  lines.push('Snapshots:   0 total');
  lines.push('Time:        1.234 s');
  lines.push('Ran all test suites.');
  if (opts.extra) lines.push(opts.extra);
  return `${lines.join('\n')}\n`;
}
