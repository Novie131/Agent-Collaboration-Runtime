import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluatePreRenderGate } from '../src/policies/jest-gate.js';
import { JEST_V1 } from '../src/policies/registry.js';
import { countProblems, parseJestResult } from '../src/renderers/jest-result.js';
import { renderJestView } from '../src/renderers/jest-view.js';

/**
 * Real Jest output captured by scripts/capture-jest-fixtures.mjs. These tests are
 * what "verified Jest version" in the jest-v1 policy refers to.
 */
const REAL = new URL('../fixtures/real/', import.meta.url).pathname;
const ROOT = '/ROOT';
const RUN = '/RUN';

interface Fixture {
  version: string;
  scenario: string;
  dir: string;
  meta: { jest_exit_code: number; jest_version: string };
  result: string;
  stdout: string;
  stderr: string;
}

function load(): Fixture[] {
  if (!existsSync(REAL)) return [];
  const out: Fixture[] = [];
  for (const v of readdirSync(REAL).filter((d) => d.startsWith('jest-'))) {
    for (const scenario of readdirSync(join(REAL, v))) {
      const dir = join(REAL, v, scenario);
      const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
      const sub = (s: string) => s.split('<ROOT>').join(ROOT).split('<RUN>').join(RUN);
      out.push({
        version: v.slice(5),
        scenario,
        dir,
        meta: JSON.parse(read('meta.json')),
        result: sub(read('jest-result.json')),
        stdout: sub(read('stdout.log')),
        stderr: sub(read('stderr.log')),
      });
    }
  }
  return out;
}

const fixtures = load();

describe.skipIf(fixtures.length === 0)('real Jest fixtures', () => {
  it('declares every captured Jest version as verified in jest-v1', () => {
    for (const f of fixtures) {
      expect(JEST_V1.verified_jest_versions).toContain(f.version);
      expect(JEST_V1.verified_jest_majors).toContain(Number(f.version.split('.')[0]));
    }
  });

  for (const f of fixtures) {
    describe(`jest ${f.version} · ${f.scenario}`, () => {
      const parsed = parseJestResult(f.result);

      it('parses with only known fields and consistent counts', () => {
        expect(parsed.ok ? 'ok' : `${parsed.reason}: ${parsed.detail}`).toBe('ok');
        if (parsed.ok) expect(countProblems(parsed.value)).toEqual([]);
      });

      it('passes gate checks 1-3 with the recorded exit code', () => {
        const g = evaluatePreRenderGate({
          policy: JEST_V1,
          jestVersion: f.version,
          jsonText: f.result,
          exitCode: f.meta.jest_exit_code,
          signal: null,
          timedOut: false,
          cancelled: null,
          captureErrors: [],
          stdoutUtf8: true,
          stderrUtf8: true,
        });
        expect(g.checks.filter((c) => !c.passed)).toEqual([]);
      });

      it('renders every failure and keeps unrecognised output', () => {
        if (!parsed.ok) return;
        const v = renderJestView({
          result: parsed.value,
          stdout: f.stdout,
          stderr: f.stderr,
          rootDir: ROOT,
          jsonPath: `${RUN}/${f.scenario}/jest-result.json`,
          process: { cwdDisplay: '.', commandDisplay: 'jest', startedAt: 'x', durationMs: 1, exitCode: f.meta.jest_exit_code, signal: null, timedOut: false, cancelled: null, wrapperExitCode: f.meta.jest_exit_code },
          artifactId: 'ae_20260101000000_00000000',
          runDirDisplay: 'run',
          policy: { id: 'jest-v1', status: 'experimental' },
        });
        for (const s of parsed.value.suites.filter((x) => x.status === 'failed')) {
          expect(v.text).toContain(s.message.replace(/\n+$/, ''));
        }
        for (const a of parsed.value.suites.flatMap((s) => s.assertions.filter((x) => x.status === 'failed'))) {
          expect(v.text).toContain(a.title);
        }
        // Every stderr line is either shown or verified as a reporter duplicate.
        const shown = new Set(v.text.split('\n'));
        for (const l of v.stderr.lines.filter((x) => x.cls === 'retained')) expect(shown.has(l.text)).toBe(true);
        if (f.scenario === 'console') {
          expect(v.text).toContain('custom log line — 日本語 ✓');
          expect(v.text).toContain('DeprecationWarning: this API will be removed');
          expect(v.text).toContain('something looked wrong but the test continues');
        }
        if (f.scenario === 'mixed') {
          expect(v.text).toContain('skipped on purpose');
          expect(v.text).toContain('write a test for negative numbers');
        }
        if (f.scenario.startsWith('pass') || f.scenario.startsWith('many-suites') || f.scenario === 'mixed') {
          // Only the "Test results written to" line may stay unrecognised here (its path is relative to the capture machine).
          expect(v.stderr.retainedLineCount).toBeLessThanOrEqual(1);
        }
      });
    });
  }
});
