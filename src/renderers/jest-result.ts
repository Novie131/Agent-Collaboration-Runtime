import { z } from 'zod';

/**
 * The subset of Jest's --json output this renderer understands. Field sets are
 * checked against real Jest output (fixtures/real/jest-*); any key outside the
 * known sets makes the integrity gate fall back to raw output.
 */

export const KNOWN_TOP_LEVEL_KEYS = new Set([
  'numFailedTestSuites',
  'numFailedTests',
  'numPassedTestSuites',
  'numPassedTests',
  'numPendingTestSuites',
  'numPendingTests',
  'numRuntimeErrorTestSuites',
  'numTodoTests',
  'numTotalTestSuites',
  'numTotalTests',
  'openHandles',
  'snapshot',
  'startTime',
  'success',
  'testResults',
  'wasInterrupted',
  'coverageMap',
  'runExecError',
]);

export const KNOWN_SUITE_KEYS = new Set([
  'assertionResults',
  'coverage',
  'endTime',
  'message',
  'name',
  'startTime',
  'status',
  'summary',
  'failureMessage',
  'testExecError',
  'perfStats',
  'displayName',
]);

export const KNOWN_ASSERTION_KEYS = new Set([
  'ancestorTitles',
  'duration',
  'failureDetails',
  'failureMessages',
  'fullName',
  'invocations',
  'location',
  'numPassingAsserts',
  'retryReasons',
  'status',
  'title',
  'startAt',
]);

const count = z.number().int().nonnegative();

export const AssertionStatus = z.enum(['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled', 'focused']);
export type AssertionStatus = z.infer<typeof AssertionStatus>;

export const JestAssertion = z
  .object({
    ancestorTitles: z.array(z.string()),
    title: z.string(),
    fullName: z.string(),
    status: AssertionStatus,
    duration: z.number().nullable().optional(),
    failureMessages: z.array(z.string()).nullable(),
    failureDetails: z.array(z.unknown()).optional(),
    location: z.object({ line: z.number(), column: z.number() }).nullable().optional(),
    numPassingAsserts: z.number().optional(),
    invocations: z.number().optional(),
    retryReasons: z.array(z.string()).optional(),
  })
  .passthrough();
export type JestAssertion = z.infer<typeof JestAssertion>;

export const JestSuite = z
  .object({
    name: z.string(),
    status: z.enum(['passed', 'failed', 'skipped', 'pending', 'focused']),
    message: z.string(),
    assertionResults: z.array(z.unknown()),
    startTime: z.number().optional(),
    endTime: z.number().optional(),
    summary: z.string().optional(),
  })
  .passthrough();
export type JestSuite = z.infer<typeof JestSuite>;

export const JestSnapshotSummary = z
  .object({
    added: count,
    failure: z.boolean(),
    filesAdded: count,
    filesRemoved: count,
    filesUnmatched: count,
    filesUpdated: count,
    matched: count,
    total: count,
    unchecked: count,
    unmatched: count,
    updated: count,
  })
  .passthrough();

export const JestAggregated = z
  .object({
    numFailedTestSuites: count,
    numFailedTests: count,
    numPassedTestSuites: count,
    numPassedTests: count,
    numPendingTestSuites: count,
    numPendingTests: count,
    numRuntimeErrorTestSuites: count,
    numTodoTests: count,
    numTotalTestSuites: count,
    numTotalTests: count,
    openHandles: z.array(z.unknown()),
    snapshot: JestSnapshotSummary,
    startTime: z.number(),
    success: z.boolean(),
    testResults: z.array(z.unknown()),
    wasInterrupted: z.boolean(),
  })
  .passthrough();
export type JestAggregated = z.infer<typeof JestAggregated>;

export interface ParsedJestResult {
  aggregated: JestAggregated;
  suites: (JestSuite & { assertions: JestAssertion[] })[];
}

export type ParseJestResult =
  | { ok: true; value: ParsedJestResult }
  | { ok: false; reason: string; detail: string };

const unknownKeys = (obj: Record<string, unknown>, known: Set<string>) => Object.keys(obj).filter((k) => !known.has(k));

export function parseJestResult(text: string): ParseJestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: 'result_json_invalid', detail: (err as Error).message };
  }
  const agg = JestAggregated.safeParse(raw);
  if (!agg.success) {
    const i = agg.error.issues[0];
    return { ok: false, reason: 'result_schema_mismatch', detail: `${i?.path.join('.') || '(root)'}: ${i?.message}` };
  }
  const topUnknown = unknownKeys(agg.data, KNOWN_TOP_LEVEL_KEYS);
  if (topUnknown.length) return { ok: false, reason: 'result_unknown_fields', detail: `top-level: ${topUnknown.join(', ')}` };
  if (agg.data.runExecError !== undefined && agg.data.runExecError !== null) {
    return { ok: false, reason: 'run_exec_error', detail: 'Jest reported runExecError' };
  }

  const suites: ParsedJestResult['suites'] = [];
  for (const [si, s] of agg.data.testResults.entries()) {
    const suite = JestSuite.safeParse(s);
    if (!suite.success) {
      const i = suite.error.issues[0];
      return { ok: false, reason: 'result_schema_mismatch', detail: `testResults.${si}.${i?.path.join('.')}: ${i?.message}` };
    }
    const su = unknownKeys(suite.data, KNOWN_SUITE_KEYS);
    if (su.length) return { ok: false, reason: 'result_unknown_fields', detail: `testResults.${si}: ${su.join(', ')}` };
    const assertions: JestAssertion[] = [];
    for (const [ai, a] of suite.data.assertionResults.entries()) {
      const as = JestAssertion.safeParse(a);
      if (!as.success) {
        const i = as.error.issues[0];
        return { ok: false, reason: 'result_schema_mismatch', detail: `testResults.${si}.assertionResults.${ai}.${i?.path.join('.')}: ${i?.message}` };
      }
      const au = unknownKeys(as.data, KNOWN_ASSERTION_KEYS);
      if (au.length) return { ok: false, reason: 'result_unknown_fields', detail: `testResults.${si}.assertionResults.${ai}: ${au.join(', ')}` };
      assertions.push(as.data);
    }
    suites.push({ ...suite.data, assertions });
  }
  return { ok: true, value: { aggregated: agg.data, suites } };
}

export const isPendingLike = (s: AssertionStatus) => s === 'pending' || s === 'skipped' || s === 'disabled';

/** Internal consistency of the counts; returns problems found (empty = consistent). */
export function countProblems(r: ParsedJestResult): string[] {
  const a = r.aggregated;
  const problems: string[] = [];
  const all = r.suites.flatMap((s) => s.assertions);
  const by = (pred: (x: JestAssertion) => boolean) => all.filter(pred).length;
  if (a.numTotalTests !== a.numPassedTests + a.numFailedTests + a.numPendingTests + a.numTodoTests) {
    problems.push('numTotalTests != passed + failed + pending + todo');
  }
  if (a.numTotalTestSuites !== a.numPassedTestSuites + a.numFailedTestSuites + a.numPendingTestSuites) {
    problems.push('numTotalTestSuites != passed + failed + pending suites');
  }
  if (r.suites.length !== a.numTotalTestSuites) problems.push(`testResults has ${r.suites.length} suites, numTotalTestSuites=${a.numTotalTestSuites}`);
  if (by((x) => x.status === 'passed') !== a.numPassedTests) problems.push('passed assertions != numPassedTests');
  if (by((x) => x.status === 'failed') !== a.numFailedTests) problems.push('failed assertions != numFailedTests');
  if (by((x) => isPendingLike(x.status)) !== a.numPendingTests) problems.push('pending/skipped assertions != numPendingTests');
  if (by((x) => x.status === 'todo') !== a.numTodoTests) problems.push('todo assertions != numTodoTests');
  if (by((x) => x.status === 'focused') > 0) problems.push('assertion status "focused" is not supported');
  for (const s of r.suites) {
    const failing = s.assertions.some((x) => x.status === 'failed');
    if (failing && s.status !== 'failed') problems.push(`suite ${s.name} has failed tests but status ${s.status}`);
    if (s.status === 'failed' && s.message.trim() === '') problems.push(`failed suite ${s.name} has an empty failure message`);
  }
  const anyFailure = a.numFailedTests > 0 || a.numFailedTestSuites > 0 || a.numRuntimeErrorTestSuites > 0 || a.snapshot.failure;
  if (a.success && anyFailure) problems.push('success=true but failures are reported');
  return problems;
}
