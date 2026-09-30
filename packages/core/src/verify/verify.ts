import type { Finding, ResultInput, Task } from '@acr/protocol/collaboration.js';
import { matchesAny } from '../task/risk.js';

/** State of the working tree when a task was claimed; changes are measured against it. */
export type GitSnapshot = {
  head: string | null;
  /** Files already dirty at claim time → content hash (null when deleted). */
  dirty: Record<string, string | null>;
};

/**
 * Read-only git access, injected so core stays offline and testable (ADR-0002). The daemon
 * supplies the real implementation; tests use an in-memory fake.
 */
export interface GitReader {
  snapshot(): Promise<GitSnapshot>;
  /** Files whose content differs from the snapshot (committed or not, tracked or untracked). */
  changedSince(snapshot: GitSnapshot): Promise<string[]>;
  /** Unified diff against the snapshot's HEAD for the given files (all changed files when omitted). */
  diff(snapshot: GitSnapshot, paths?: string[]): Promise<string>;
}

export type TestEvidence = { artifact: string; passed: number; failed: number } | null;

const inScope = (file: string, scope: readonly string[]) =>
  scope.some((s) => {
    const p = s.replace(/\/+$/, '');
    return file === p || file.startsWith(`${p}/`) || matchesAny(file, [s]);
  });

/** Compares Claude's claims with what git and the test artifact show (SPEC §21). Pure. */
export function verifyResult(input: {
  task: Task;
  result: ResultInput;
  changedFiles: string[] | null;
  tests: TestEvidence;
  testArtifactProblem?: string;
}): Finding[] {
  const { task, result, changedFiles, tests } = input;
  const findings: Finding[] = [];

  if (changedFiles === null) {
    findings.push({ code: 'git_unavailable', detail: 'git state could not be read; changed files are unverified', paths: [], blocking: true });
  } else {
    const claimed = new Set(result.changes.map((c) => c.path));
    const actual = new Set(changedFiles);
    const unclaimed = changedFiles.filter((f) => !claimed.has(f));
    const phantom = [...claimed].filter((f) => !actual.has(f));
    const outOfScope = changedFiles.filter((f) => !inScope(f, task.scope.paths));
    if (unclaimed.length) {
      findings.push({ code: 'unclaimed_change', detail: `${unclaimed.length} changed file(s) not listed in the result`, paths: unclaimed, blocking: true });
    }
    if (phantom.length) {
      findings.push({ code: 'claimed_but_unchanged', detail: `${phantom.length} listed file(s) show no change`, paths: phantom, blocking: true });
    }
    if (outOfScope.length) {
      findings.push({ code: 'out_of_scope_change', detail: `${outOfScope.length} changed file(s) outside the task scope`, paths: outOfScope, blocking: true });
    }
  }

  if (result.tests) {
    if (!tests) {
      findings.push({
        code: 'tests_unverified',
        detail: input.testArtifactProblem ?? 'test counts were claimed without a run_tests artifact from this task',
        paths: [],
        blocking: false,
      });
    } else if (tests.passed !== result.tests.passed || tests.failed !== result.tests.failed) {
      findings.push({
        code: 'test_count_mismatch',
        detail: `claimed ${result.tests.passed} passed / ${result.tests.failed} failed; artifact ${tests.artifact} shows ${tests.passed} / ${tests.failed}`,
        paths: [],
        blocking: true,
      });
    }
  }
  if (tests && tests.failed > 0) {
    findings.push({ code: 'test_failures', detail: `${tests.failed} test(s) failing in ${tests.artifact}`, paths: [], blocking: true });
  }
  return findings;
}
