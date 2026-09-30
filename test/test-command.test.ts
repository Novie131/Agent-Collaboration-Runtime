import { createWriteStream, type WriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expandArtifact } from '@acr/artifacts/expand.js';
import { RunManifest } from '@acr/artifacts/manifest.js';
import { ArtifactError } from '@acr/artifacts/store.js';
import { JEST_V1 } from '@acr/runner/policy-registry.js';
import { runJest } from '@acr/runner/jest.js';
import { runTestCommand, WRAPPER_EXIT, type TestCommandOptions } from '@acr/runner/test-command.js';
import { makeResult, makeStderr } from './helpers/jest.js';

const FAKE_JEST = `
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--outputFile='));
const out = outArg && outArg.slice('--outputFile='.length);
fs.appendFileSync(path.join(process.cwd(), 'invocations.log'), JSON.stringify(args) + '\\n');
const sc = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scenario.json'), 'utf8'));
if (sc.hang) { setInterval(() => {}, 1000); return; }
if (sc.selfSignal) { process.kill(process.pid, sc.selfSignal); setInterval(() => {}, 1000); return; }
if (sc.result && out) fs.writeFileSync(out, typeof sc.result === 'string' ? sc.result : JSON.stringify(sc.result).split(sc.rootToken).join(JSON.stringify(process.cwd()).slice(1, -1)));
if (sc.stdout) process.stdout.write(sc.stdout);
if (sc.stderr) process.stderr.write(sc.stderr);
process.exitCode = sc.exit;
`;

class Sink extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  get text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

let project: string;
let base: string;
const saved = { majors: [...JEST_V1.verified_jest_majors], versions: [...JEST_V1.verified_jest_versions] };
const FAKE_VERSION = '29.7.0';

beforeAll(() => {
  // The fake Jest reports 29.7.0; make sure the policy treats that major as verified for these tests.
  if (!JEST_V1.verified_jest_majors.includes(29)) JEST_V1.verified_jest_majors.push(29);
  if (!JEST_V1.verified_jest_versions.includes(FAKE_VERSION)) JEST_V1.verified_jest_versions.push(FAKE_VERSION);
});
afterAll(() => {
  JEST_V1.verified_jest_majors.splice(0, Infinity, ...saved.majors);
  JEST_V1.verified_jest_versions.splice(0, Infinity, ...saved.versions);
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ae-test-'));
  project = join(base, 'proj');
  await mkdir(join(project, 'node_modules', 'jest', 'bin'), { recursive: true });
  await writeFile(join(project, 'package.json'), '{"name":"fake","private":true}');
  await writeFile(join(project, 'node_modules', 'jest', 'package.json'), JSON.stringify({ name: 'jest', version: FAKE_VERSION, bin: './bin/jest.js' }));
  await writeFile(join(project, 'node_modules', 'jest', 'bin', 'jest.js'), FAKE_JEST);
});

/** Writes a scenario whose result paths use the fake project root. */
async function scenario(sc: Record<string, unknown>) {
  let s = sc;
  if (sc.result && typeof sc.result === 'object') {
    s = { ...sc, rootToken: '/work/proj', result: sc.result, stderr: sc.stderr };
  }
  await writeFile(join(project, 'scenario.json'), JSON.stringify(s));
}

async function run(mode: TestCommandOptions['mode'], extra: Partial<TestCommandOptions> = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const runDir = join(base, `run-${Math.random().toString(16).slice(2)}`);
  const code = await runTestCommand({
    mode,
    ...(mode === 'optimize' ? { policyId: 'jest-v1' } : {}),
    allowExperimental: true,
    projectRoot: project,
    runDir,
    jestArgs: ['--runInBand'],
    stdout,
    stderr,
    ...extra,
  });
  const manifest = await readFile(join(runDir, 'manifest.json'), 'utf8').then((t) => RunManifest.parse(JSON.parse(t)), () => undefined);
  const invocations = (await readFile(join(project, 'invocations.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
  return { code, stdout: stdout.text, stderr: stderr.text, manifest, runDir, invocations };
}

// Large enough that a correct view is smaller than the raw verbose output.
const manyPassed = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `handles input case number ${i}`, ancestors: ['parser'], status: 'passed' as const }));
const passing = makeResult([{ name: 'src/a.test.js', tests: manyPassed(200) }]);
const failing = makeResult([
  { name: 'src/a.test.js', tests: [...manyPassed(200), { title: 'broken', status: 'failed', failure: 'Expected: 2\n    Received: 1' }] },
]);

describe('optimize mode', () => {
  it('returns the structured view for a passing run and keeps exit code 0', async () => {
    await scenario({ result: passing, stderr: makeStderr(passing, { verbose: true }).split('/work/proj').join(project), exit: 0 });
    const r = await run('optimize');
    expect(r.code).toBe(0);
    expect(r.manifest!.output.returned).toBe('structured_view');
    expect(r.stdout).toContain('Tests: 200 passed, 200 total');
    expect(r.stdout).toContain('passed: names of 200 passed test(s)');
    expect(r.invocations).toBe(1);
    expect(r.manifest!.command.wrapper_added_args[0]).toBe('--json');
  });

  it('returns failures in full and exit code 1; raw text stays retrievable', async () => {
    const stderr = makeStderr(failing, { verbose: true });
    await scenario({ result: failing, stderr: `${stderr}${'noise line that is not reporter output\n'.repeat(2)}`, exit: 1 });
    const r = await run('optimize');
    expect(r.code).toBe(1);
    expect(r.manifest!.output.returned).toBe('structured_view');
    expect(r.stdout).toContain('Expected: 2');
    expect(r.stdout).toContain('● broken');
    expect(r.stdout).toContain('noise line that is not reporter output');
    const out = new Sink();
    await expandArtifact({ artifactId: r.manifest!.artifact_id, runDir: r.runDir, part: 'stderr', raw: true, stdout: out, stderr: new Sink() });
    expect(out.text).toBe(`${stderr}${'noise line that is not reporter output\n'.repeat(2)}`);
  });

  it('falls back to raw output without re-running when exit and JSON disagree', async () => {
    await scenario({ result: passing, stderr: 'weird\n', stdout: 'raw stdout\n', exit: 1 });
    const r = await run('optimize');
    expect(r.code).toBe(1);
    expect(r.invocations).toBe(1);
    expect(r.manifest!.output).toMatchObject({ returned: 'raw', fallback_reason: 'exit_result_contradiction' });
    expect(r.stdout).toBe('raw stdout\n');
    expect(r.stderr).toContain('weird\n');
    expect(r.stderr).toContain('tests were not re-run');
    expect(r.stdout).not.toContain('200 passed');
  });

  it('falls back when Jest writes no JSON (unknown format), keeping the original status', async () => {
    await scenario({ stderr: 'Error: config broken\n', exit: 1 });
    const r = await run('optimize');
    expect(r.code).toBe(1);
    expect(r.manifest!.output.fallback_reason).toBe('result_json_missing');
    expect(r.stderr).toContain('Error: config broken');
  });

  it('falls back when the view would not be smaller', async () => {
    const tiny = makeResult([{ name: 'src/a.test.js', tests: [{ title: 'x', status: 'passed' }] }]);
    await scenario({ result: tiny, stderr: 'PASS src/a.test.js\n', exit: 0 });
    const r = await run('optimize');
    expect(r.code).toBe(0);
    expect(r.manifest!.output.fallback_reason).toBe('view_not_smaller');
    expect(r.stderr).toContain('PASS src/a.test.js');
  });

  it('requires --allow-experimental for an experimental policy', async () => {
    await scenario({ result: passing, exit: 0 });
    const r = await run('optimize', { allowExperimental: false });
    expect(r.code).toBe(WRAPPER_EXIT.wrapperError);
    expect(r.invocations).toBe(0);
  });
});

describe('shadow and passthrough', () => {
  it('shadow returns raw output live but records the candidate view', async () => {
    const stderr = makeStderr(passing);
    await scenario({ result: passing, stderr, exit: 0 });
    const r = await run('shadow');
    expect(r.code).toBe(0);
    expect(r.stderr.startsWith(stderr)).toBe(true);
    expect(r.manifest!.output.returned).toBe('raw');
    expect(r.manifest!.files.view).toBeDefined();
    expect(r.manifest!.output.view_bytes).toBeGreaterThan(0);
  });

  it('passthrough writes no view', async () => {
    await scenario({ result: passing, stderr: 'x\n', exit: 0 });
    const r = await run('passthrough');
    expect(r.code).toBe(0);
    expect(r.manifest!.policy).toBeNull();
    expect(r.manifest!.files.view).toBeUndefined();
  });
});

describe('abnormal execution never reports a pass', () => {
  it('timeout → 124', async () => {
    await scenario({ hang: true });
    const r = await run('optimize', { timeoutMs: 500 });
    expect(r.code).toBe(WRAPPER_EXIT.timeout);
    expect(r.manifest!.exit.timed_out).toBe(true);
    expect(r.stderr).toContain('not a passing result');
  });

  // POSIX self-signals do not exist on Windows (SPEC §6.4); the mapping is exercised on macOS/Linux.
  it.skipIf(process.platform === 'win32')('killed by signal → 128+n with the signal recorded', async () => {
    await scenario({ selfSignal: 'SIGTERM' });
    const r = await run('optimize');
    expect(r.code).toBe(143);
    expect(r.manifest!.exit).toMatchObject({ signal: 'SIGTERM', signal_mapping: 'SIGTERM -> 128+n' });
  });

  it('disk full while saving output → wrapper error 125, even if Jest exited 0', async () => {
    await scenario({ result: passing, stdout: 'some stdout\n', stderr: makeStderr(passing), exit: 0 });
    const failing = (p: string) => {
      if (!p.endsWith('stdout.log')) return createWriteStream(p, { flags: 'wx', mode: 0o600 });
      const w = new Writable({ write: (_c, _e, cb) => cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })) });
      return w as unknown as WriteStream;
    };
    const r = await run('optimize', { runJestImpl: (o) => runJest({ ...o, createStream: failing }) });
    expect(r.code).toBe(WRAPPER_EXIT.wrapperError);
    expect(r.manifest!.exit.wrapper_error).toMatch(/ENOSPC/);
    expect(r.manifest!.output.returned).toBe('raw');
    expect(r.stdout).toBe('some stdout\n');
  });

  it('refuses watch mode and conflicting reporter args before running', async () => {
    await scenario({ result: passing, exit: 0 });
    for (const bad of ['--watch', '--watch-all', '--json', '--outputFile=x.json', '--testResultsProcessor=x']) {
      const r = await run('optimize', { jestArgs: [bad] });
      expect(r.code).toBe(WRAPPER_EXIT.wrapperError);
    }
    expect((await run('optimize', { jestArgs: ['--no-watch', '-i'] })).code).toBe(0);
  });

  it('reports a missing local Jest clearly and does not install it', async () => {
    await rm(join(project, 'node_modules'), { recursive: true });
    const r = await run('optimize');
    expect(r.code).toBe(WRAPPER_EXIT.wrapperError);
    expect(r.stderr).toMatch(/never installs/);
  });

  it('refuses to reuse an existing run-dir', async () => {
    await scenario({ result: passing, exit: 0 });
    const runDir = join(base, 'fixed');
    await mkdir(runDir);
    const r = await run('optimize', { runDir });
    expect(r.code).toBe(WRAPPER_EXIT.wrapperError);
    expect(r.invocations).toBe(0);
  });
});

describe('artifacts and expand', () => {
  async function stored() {
    await scenario({ result: failing, stderr: `${makeStderr(failing)}token=supersecretvalue123\n`, exit: 1 });
    return run('optimize');
  }

  it('sanitizes by default, shows the notice once, and returns raw bytes on request', async () => {
    const r = await stored();
    const id = r.manifest!.artifact_id;
    const out1 = new Sink();
    const err1 = new Sink();
    await expandArtifact({ artifactId: id, runDir: r.runDir, part: 'stderr', raw: false, stdout: out1, stderr: err1 });
    expect(out1.text).not.toContain('supersecretvalue123');
    expect(err1.text).toContain('best-effort');
    const err2 = new Sink();
    await expandArtifact({ artifactId: id, runDir: r.runDir, part: 'stderr', raw: false, stdout: new Sink(), stderr: err2 });
    expect(err2.text).toBe('');
    const raw = new Sink();
    await expandArtifact({ artifactId: id, runDir: r.runDir, part: 'stderr', raw: true, stdout: raw, stderr: new Sink() });
    expect(raw.text).toContain('supersecretvalue123');
  });

  it('derives failures and passed lists from the stored result', async () => {
    const r = await stored();
    const out = new Sink();
    await expandArtifact({ artifactId: r.manifest!.artifact_id, runDir: r.runDir, part: 'failures', raw: true, stdout: out, stderr: new Sink() });
    expect(out.text).toContain('› broken');
    expect(out.text).toContain('node_modules/jest-circus');
  });

  it('detects a modified artifact (hash mismatch)', async () => {
    const r = await stored();
    const p = join(r.runDir, 'stderr.log');
    await chmod(p, 0o600);
    await writeFile(p, 'tampered');
    await expect(expandArtifact({ artifactId: r.manifest!.artifact_id, runDir: r.runDir, part: 'stderr', raw: true, stdout: new Sink(), stderr: new Sink() })).rejects.toMatchObject({ code: 'hash_mismatch' });
  });

  it('reports a deleted artifact file', async () => {
    const r = await stored();
    await rm(join(r.runDir, 'jest-result.json'));
    await expect(expandArtifact({ artifactId: r.manifest!.artifact_id, runDir: r.runDir, part: 'result', raw: true, stdout: new Sink(), stderr: new Sink() })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects traversal-style ids, foreign ids and symlinked parts', async () => {
    const r = await stored();
    for (const id of ['../../etc/passwd', 'ae_x/../../y', '/etc/passwd']) {
      await expect(expandArtifact({ artifactId: id, runDir: r.runDir, part: 'stdout', raw: true, stdout: new Sink(), stderr: new Sink() })).rejects.toMatchObject({ code: 'invalid_id' });
    }
    await expect(expandArtifact({ artifactId: 'ae_20200101000000_00000000', runDir: r.runDir, part: 'stdout', raw: true, stdout: new Sink(), stderr: new Sink() })).rejects.toBeInstanceOf(ArtifactError);
    await rm(join(r.runDir, 'stdout.log'));
    await symlink('/etc/hosts', join(r.runDir, 'stdout.log'));
    await expect(expandArtifact({ artifactId: r.manifest!.artifact_id, runDir: r.runDir, part: 'stdout', raw: true, stdout: new Sink(), stderr: new Sink() })).rejects.toMatchObject({ code: 'unsafe_path' });
  });
});
