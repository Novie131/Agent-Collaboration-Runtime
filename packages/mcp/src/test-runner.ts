import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { TestRunner } from '@acr/core/hub.js';
import type { WorkspaceConfig } from '@acr/core/config.js';
import { runTestCommand } from '@acr/runner/test-command.js';

class Capture extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }
  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * `run_tests` for the local endpoint: the legacy Jest runner (run once, integrity gate, view or raw)
 * with its output captured and its counts read from Jest's own JSON result.
 */
export class JestTestRunner implements TestRunner {
  private seq = 0;

  constructor(
    private readonly projectRoot: string,
    private readonly runsDir: string,
    private readonly runner: WorkspaceConfig['runner'],
  ) {}

  async run({ jestArgs }: { jestArgs: string[] }) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const runDir = join(this.runsDir, `run-${stamp}-${++this.seq}`);
    const stdout = new Capture();
    const stderr = new Capture();
    const exitCode = await runTestCommand({
      mode: this.runner.mode,
      policyId: this.runner.policy,
      allowExperimental: this.runner.allow_experimental,
      projectRoot: this.projectRoot,
      runDir,
      jestArgs,
      timeoutMs: this.runner.timeout_ms,
      stdout,
      stderr,
    });
    let passed: number | null = null;
    let failed: number | null = null;
    let runArtifactId: string | null = null;
    let returned: 'raw' | 'structured_view' = 'raw';
    try {
      const result = JSON.parse(await readFile(join(runDir, 'jest-result.json'), 'utf8')) as { numPassedTests?: unknown; numFailedTests?: unknown };
      if (typeof result.numPassedTests === 'number' && typeof result.numFailedTests === 'number') {
        passed = result.numPassedTests;
        failed = result.numFailedTests;
      }
    } catch {
      // No JSON result (setup error, timeout, crash): counts stay unknown and verification says so.
    }
    try {
      const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as { artifact_id?: string; output?: { returned?: string } };
      runArtifactId = manifest.artifact_id ?? null;
      if (manifest.output?.returned === 'structured_view') returned = 'structured_view';
    } catch {
      // manifest missing means the wrapper failed early; the stderr capture explains why.
    }
    const out = stdout.text();
    const err = stderr.text();
    return { exitCode, output: err ? `${out}${out && !out.endsWith('\n') ? '\n' : ''}${err}` : out, passed, failed, returned, runArtifactId, runDir };
  }
}
