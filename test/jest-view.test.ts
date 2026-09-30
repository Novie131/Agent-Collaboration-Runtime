import { describe, expect, it } from 'vitest';
import { evaluatePreRenderGate } from '@acr/runner/jest-gate.js';
import { JEST_V1 } from '@acr/runner/policy-registry.js';
import { parseJestResult } from '@acr/compression/jest-result.js';
import { renderJestView } from '@acr/compression/jest-view.js';
import { makeResult, makeStderr, ROOT } from './helpers/jest.js';

const policy = { ...JEST_V1, verified_jest_majors: [29], verified_jest_versions: ['29.7.0'] };

function view(result: ReturnType<typeof makeResult>, stderr: string, stdout = '') {
  const parsed = parseJestResult(JSON.stringify(result));
  if (!parsed.ok) throw new Error(parsed.detail);
  return renderJestView({
    result: parsed.value,
    stdout,
    stderr,
    rootDir: ROOT,
    jsonPath: `${ROOT}/run/jest-result.json`,
    process: { cwdDisplay: '.', commandDisplay: 'jest', startedAt: '2026-01-01T00:00:00Z', durationMs: 1234, exitCode: result.success ? 0 : 1, signal: null, timedOut: false, cancelled: null, wrapperExitCode: result.success ? 0 : 1 },
    artifactId: 'ae_20260101000000_deadbeef',
    runDirDisplay: 'run',
    policy: { id: 'jest-v1', status: 'experimental' },
  });
}

function gate(result: unknown, exitCode: number | null, extra: Partial<Parameters<typeof evaluatePreRenderGate>[0]> = {}) {
  return evaluatePreRenderGate({
    policy,
    jestVersion: '29.7.0',
    jsonText: typeof result === 'string' ? result : JSON.stringify(result),
    exitCode,
    signal: null,
    timedOut: false,
    cancelled: null,
    captureErrors: [],
    stdoutUtf8: true,
    stderrUtf8: true,
    ...extra,
  });
}

describe('passing tests', () => {
  const result = makeResult([
    { name: 'src/a.test.js', tests: Array.from({ length: 30 }, (_, i) => ({ title: `adds case ${i}`, ancestors: ['sum'], status: 'passed' as const })) },
    { name: 'src/b.test.js', tests: [{ title: 'b works', status: 'passed' }] },
  ]);
  const stderr = makeStderr(result, { verbose: true });

  it('summarises passed names with counts matching the result and an expand entry', () => {
    const v = view(result, stderr);
    expect(v.text).toContain('Tests: 31 passed, 31 total');
    expect(v.text).not.toContain('adds case 7');
    expect(v.omitted.find((o) => o.kind.includes('passed test'))!.expand).toContain('--part passed');
    expect(Buffer.byteLength(v.text)).toBeLessThan(Buffer.byteLength(stderr));
    expect(v.stderr.retainedLineCount).toBe(0);
  });

  it('passes the gate with exit 0', () => {
    expect(gate(result, 0).passed).toBe(true);
  });
});

describe('failing tests', () => {
  const result = makeResult([
    {
      name: 'src/f.test.js',
      tests: [
        { title: 'one', status: 'failed', failure: 'expect(received).toBe(expected)\n\n    Expected: 2\n    Received: 1' },
        { title: 'two', ancestors: ['group'], status: 'failed', failure: 'Unicode ✓ 漢字 — diff\n    - a\n    + b' },
        { title: 'three', status: 'passed' },
      ],
    },
    { name: 'src/g.test.js', tests: [{ title: 'g', status: 'failed', failure: 'boom' }] },
  ]);
  const stderr = makeStderr(result);

  it('keeps every failure name, message, stack and diff', () => {
    const v = view(result, stderr);
    for (const s of result.testResults) expect(v.text).toContain(s.message.trimEnd());
    expect(v.text).toContain('● one');
    expect(v.text).toContain('● group › two');
    expect(v.text).toContain('FAIL src/g.test.js');
    expect(v.text).toContain('Expected: 2');
    expect(v.text).toContain('Unicode ✓ 漢字');
    expect(v.text).toContain('at Object.<anonymous>');
    expect(v.stderr.duplicateFailureBlocks).toBe(2);
    expect(v.failuresAddedFromRaw).toBe(0);
  });

  it('adds raw failureMessages when a failed test is missing from the suite message', () => {
    const r = makeResult([{ name: 'src/h.test.js', tests: [{ title: 'hidden', status: 'failed' }], message: '  ● Test suite failed to run\n\n    SyntaxError' }]);
    const v = view(r, makeStderr(r));
    expect(v.failuresAddedFromRaw).toBe(1);
    expect(v.text).toContain('Error: Error\n    at Object.<anonymous>');
  });
});

describe('mixed statuses', () => {
  it('reports skipped / todo separately, never as passed', () => {
    const r = makeResult([
      { name: 'src/m.test.js', tests: [{ title: 'p', status: 'passed' }, { title: 's', status: 'pending' }, { title: 't', status: 'todo' }] },
    ]);
    const v = view(r, makeStderr(r, { verbose: true }));
    expect(v.text).toContain('Tests: 1 skipped, 1 todo, 1 passed, 3 total');
    expect(v.text).toContain('○ pending src/m.test.js › s');
    expect(v.text).toContain('✎ todo src/m.test.js › t');
    expect(gate(r, 0).passed).toBe(true);
  });
});

describe('special output is kept', () => {
  const r = makeResult([{ name: 'src/a.test.js', tests: [{ title: 'x', status: 'passed' }] }]);

  it('keeps unrecognised stderr (warnings, console output) verbatim with its suite header', () => {
    const consoleBlock = '  ● Console\n\n    console.log\n      hello — 世界\n\n      at Object.log (src/a.test.js:2:11)';
    const stderr = makeStderr(r, { console: consoleBlock, extra: 'A worker process has failed to exit gracefully and has been force exited...' });
    const v = view(r, stderr);
    expect(v.text).toContain('hello — 世界');
    expect(v.text).toContain('A worker process has failed to exit gracefully');
    expect(v.text).toContain('PASS src/a.test.js   [suite header, shown for context]');
  });

  it('keeps all stdout verbatim', () => {
    const v = view(r, makeStderr(r), 'global setup: connecting to db\nmulti\nline\n');
    expect(v.text).toContain('global setup: connecting to db\nmulti\nline');
  });

  it('keeps a summary line whose counts do not match the result', () => {
    const stderr = makeStderr(r).replace('Tests:       1 passed, 1 total', 'Tests:       2 passed, 2 total');
    const v = view(r, stderr);
    expect(v.text).toContain('Tests:       2 passed, 2 total');
  });
});

describe('unknown format falls back', () => {
  const r = makeResult([{ name: 'src/a.test.js', tests: [{ title: 'x', status: 'passed' }] }]);

  it('unverified Jest version', () => {
    expect(gate(r, 0, { jestVersion: '31.0.0' })).toMatchObject({ passed: false, fallbackReason: 'unverified_jest_version' });
  });
  it('broken JSON', () => {
    expect(gate('{"numFailedTests": 1', 0)).toMatchObject({ passed: false, fallbackReason: 'result_json_invalid' });
  });
  it('missing required field', () => {
    const { numTodoTests: _drop, ...rest } = r;
    expect(gate(rest, 0)).toMatchObject({ passed: false, fallbackReason: 'result_schema_mismatch' });
  });
  it('unknown top-level or nested field', () => {
    expect(gate({ ...r, newCriticalField: true }, 0)).toMatchObject({ passed: false, fallbackReason: 'result_unknown_fields' });
    const nested = structuredClone(r);
    (nested.testResults[0]!.assertionResults[0] as Record<string, unknown>).retried = 3;
    expect(gate(nested, 0)).toMatchObject({ passed: false, fallbackReason: 'result_unknown_fields' });
  });
  it('missing JSON file', () => {
    expect(evaluatePreRenderGate({ policy, jestVersion: '29.7.0', jsonText: undefined, exitCode: 1, signal: null, timedOut: false, cancelled: null, captureErrors: [], stdoutUtf8: true, stderrUtf8: true })).toMatchObject({ passed: false, fallbackReason: 'result_json_missing' });
  });
});

describe('contradictions', () => {
  const green = makeResult([{ name: 'src/a.test.js', tests: [{ title: 'x', status: 'passed' }] }]);

  it('exit non-zero but JSON all green: no passing summary', () => {
    expect(gate(green, 1)).toMatchObject({ passed: false, fallbackReason: 'exit_result_contradiction' });
  });
  it('exit 0 but failures reported', () => {
    const red = makeResult([{ name: 'src/a.test.js', tests: [{ title: 'x', status: 'failed' }] }]);
    expect(gate(red, 0).passed).toBe(false);
  });
  it('success=true with failures', () => {
    const red = makeResult([{ name: 'src/a.test.js', tests: [{ title: 'x', status: 'failed' }] }], { success: true });
    expect(gate(red, 1).fallbackReason).toBe('result_inconsistent');
  });
  it('counts that do not add up', () => {
    expect(gate({ ...green, numTotalTests: 5 }, 0).fallbackReason).toBe('result_inconsistent');
  });
  it('interrupted run', () => {
    expect(gate({ ...green, wasInterrupted: true }, 0).passed).toBe(false);
  });
});

describe('abnormal process states never pass', () => {
  const green = makeResult([{ name: 'src/a.test.js', tests: [{ title: 'x', status: 'passed' }] }]);
  it.each([
    ['timeout', { timedOut: true }],
    ['signal', { signal: 'SIGKILL', exitCode: null }],
    ['cancel', { cancelled: 'SIGINT' }],
    ['disk full', { captureErrors: ['ENOSPC: no space left on device'] }],
    ['non-utf8', { stderrUtf8: false }],
  ] as const)('%s', (_name, extra) => {
    const g = gate(green, 'exitCode' in extra ? (extra.exitCode as null) : 0, extra as never);
    expect(g.passed).toBe(false);
  });
});
