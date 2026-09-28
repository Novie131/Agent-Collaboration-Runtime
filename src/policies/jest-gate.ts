import type { PolicyDefinition } from './registry.js';
import { countProblems, parseJestResult, type ParsedJestResult } from '../renderers/jest-result.js';

export interface GateCheck {
  check: string;
  passed: boolean;
  detail: string | null;
}

export interface GateInput {
  policy: PolicyDefinition;
  jestVersion: string;
  jsonText: string | undefined;
  jsonMissingReason?: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: string | null;
  spawnError?: string;
  captureErrors: string[];
  stdoutUtf8: boolean;
  stderrUtf8: boolean;
}

export interface GateResult {
  passed: boolean;
  checks: GateCheck[];
  fallbackReason: string | null;
  fallbackDetail: string | null;
  parsed?: ParsedJestResult;
}

/**
 * Checks 1–3 of the integrity gate (format, process completeness, failure
 * information). Check 4 (artifact hashes) and 5 (size) are added by the caller
 * once the files are written and the view is rendered.
 */
export function evaluatePreRenderGate(input: GateInput): GateResult {
  const checks: GateCheck[] = [];
  let fallbackReason: string | null = null;
  let fallbackDetail: string | null = null;
  const fail = (check: string, reason: string, detail: string) => {
    checks.push({ check, passed: false, detail });
    if (!fallbackReason) {
      fallbackReason = reason;
      fallbackDetail = detail;
    }
  };
  const pass = (check: string, detail: string | null = null) => checks.push({ check, passed: true, detail });

  // 1. format and version
  const major = Number(input.jestVersion.split('.')[0]);
  if (!input.policy.verified_jest_majors.includes(major)) {
    fail('format.version', 'unverified_jest_version', `Jest ${input.jestVersion} is not in the verified set [${input.policy.verified_jest_versions.join(', ')}]`);
  } else {
    pass('format.version', `Jest ${input.jestVersion}`);
  }
  let parsed: ParsedJestResult | undefined;
  if (input.jsonText === undefined) {
    fail('format.result', 'result_json_missing', input.jsonMissingReason ?? 'Jest did not write a JSON result');
  } else {
    const r = parseJestResult(input.jsonText);
    if (r.ok) {
      parsed = r.value;
      pass('format.result');
    } else {
      fail('format.result', r.reason, r.detail);
    }
  }

  // 2. process completeness and consistency
  if (input.spawnError) fail('process.spawn', 'spawn_error', input.spawnError);
  if (input.timedOut) fail('process.timeout', 'timed_out', 'wrapper timeout reached');
  if (input.cancelled) fail('process.cancelled', 'cancelled', `received ${input.cancelled}`);
  if (input.signal) fail('process.signal', 'terminated_by_signal', input.signal);
  if (input.exitCode === null && !input.spawnError && !input.signal) fail('process.exit', 'exit_status_missing', 'no exit code');
  if (!input.spawnError && !input.timedOut && !input.cancelled && !input.signal && input.exitCode !== null) pass('process.complete', `exit ${input.exitCode}`);
  if (parsed) {
    const a = parsed.aggregated;
    if (a.wasInterrupted) fail('process.interrupted', 'run_interrupted', 'Jest reported wasInterrupted');
    const problems = countProblems(parsed);
    if (problems.length) fail('result.consistency', 'result_inconsistent', problems.join('; '));
    else pass('result.consistency');
    if (input.exitCode !== null) {
      if (input.exitCode === 0 && !a.success) fail('result.exit_agreement', 'exit_result_contradiction', 'exit 0 but success=false');
      else if (input.exitCode !== 0 && a.success) fail('result.exit_agreement', 'exit_result_contradiction', `exit ${input.exitCode} but success=true; not reporting a passing summary`);
      else pass('result.exit_agreement');
    }
  }

  // 3. capture completeness (failure information itself is checked in result.consistency)
  if (input.captureErrors.length) fail('capture.complete', 'capture_write_error', input.captureErrors.join('; '));
  else pass('capture.complete');
  if (!input.stdoutUtf8 || !input.stderrUtf8) fail('capture.utf8', 'output_not_utf8', 'stdout/stderr is not valid UTF-8; a text view could alter bytes');
  else pass('capture.utf8');

  return { passed: fallbackReason === null, checks, fallbackReason, fallbackDetail, ...(parsed ? { parsed } : {}) };
}
