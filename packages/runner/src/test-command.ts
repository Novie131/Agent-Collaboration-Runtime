import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { platform } from 'node:os';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MANIFEST_FILE, PART_FILES, type RunManifest, type StoredPart } from '@acr/artifacts/manifest.js';
import { ArtifactError, createRunDir, hashFile, newArtifactId, readRunFile, runDirPaths, sha256Hex, writeNewFile } from '@acr/artifacts/store.js';
import { evaluatePreRenderGate, type GateCheck } from './jest-gate.js';
import { POLICIES, policyHash, type PolicyDefinition } from './policy-registry.js';
import { effectiveStatus } from './policy-state.js';
import { displayPath, redactText } from '@acr/security/redact.js';
import { renderJestView, type JestView } from '@acr/compression/jest-view.js';
import { TOOL_VERSION } from '@acr/platform/version.js';
import { checkJestArgs } from './jest-args.js';
import { locateJest, runJest, RunnerSetupError, signalExitCode, type JestProcessResult } from './jest.js';

export type TestMode = 'shadow' | 'optimize' | 'passthrough';

/** Exit codes the wrapper itself uses; everything else is Jest's own status. */
export const WRAPPER_EXIT = {
  wrapperError: 125,
  timeout: 124,
} as const;

export interface TestCommandOptions {
  mode: TestMode;
  policyId?: string;
  allowExperimental: boolean;
  projectRoot: string;
  runDir: string;
  jestArgs: string[];
  timeoutMs?: number;
  stdout: Writable;
  stderr: Writable;
  now?: () => Date;
  /** Test seam for the capture streams. */
  runJestImpl?: typeof runJest;
}

const note = (w: Writable, msg: string) => w.write(`[acr] ${msg}\n`);

function gitState(cwd: string): { head: string | null; dirty: boolean | null } {
  const run = (args: string[]) => spawnSync('git', args, { cwd, shell: false, encoding: 'utf8', timeout: 10_000 });
  const head = run(['rev-parse', 'HEAD']);
  const status = run(['status', '--porcelain']);
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

function isUtf8(b: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

function wrapperExitCode(proc: JestProcessResult): { code: number; mapping: string | null } {
  if (proc.spawnError) return { code: WRAPPER_EXIT.wrapperError, mapping: null };
  if (proc.timedOut) return { code: WRAPPER_EXIT.timeout, mapping: 'wrapper timeout -> 124' };
  if (proc.cancelled) return { code: signalExitCode(proc.cancelled), mapping: `cancelled by ${proc.cancelled} -> 128+n` };
  if (proc.signal) return { code: signalExitCode(proc.signal), mapping: `${proc.signal} -> 128+n` };
  if (proc.exitCode === null) return { code: WRAPPER_EXIT.wrapperError, mapping: null };
  return { code: proc.exitCode, mapping: null };
}

async function emitRaw(target: Writable, memory: Buffer | undefined, complete: boolean, path: string) {
  if (memory && complete) {
    if (memory.length) target.write(memory);
    return;
  }
  await pipeline(createReadStream(path), target, { end: false });
}

export async function runTestCommand(opts: TestCommandOptions): Promise<number> {
  const err = opts.stderr;
  const now = opts.now ?? (() => new Date());

  // --- policy selection -------------------------------------------------------
  let policy: PolicyDefinition | undefined;
  if (opts.mode !== 'passthrough') {
    const id = opts.policyId ?? (opts.mode === 'shadow' ? 'jest-v1' : undefined);
    if (!id) {
      note(err, 'optimize mode needs --policy <id> (see: acr policies)');
      return WRAPPER_EXIT.wrapperError;
    }
    policy = POLICIES[id];
    if (!policy) {
      note(err, `unknown policy "${id}" (see: acr policies)`);
      return WRAPPER_EXIT.wrapperError;
    }
  }
  const status = policy ? effectiveStatus({ policyId: policy.id, disabled: false }) : undefined;
  if (opts.mode === 'optimize' && status?.status === 'disabled') {
    note(err, `policy ${policy!.id} is disabled`);
    return WRAPPER_EXIT.wrapperError;
  }
  if (opts.mode === 'optimize' && status?.status === 'experimental' && !opts.allowExperimental) {
    note(err, `policy ${policy!.id} is experimental (${status.reason}); pass --allow-experimental to use it in optimize mode`);
    return WRAPPER_EXIT.wrapperError;
  }

  // --- argument and environment checks ---------------------------------------
  const argCheck = checkJestArgs(opts.jestArgs);
  if (!argCheck.ok) {
    for (const d of argCheck.denied) note(err, `refused Jest argument ${d.arg}: ${d.reason}`);
    return WRAPPER_EXIT.wrapperError;
  }
  let located;
  try {
    located = await locateJest(opts.projectRoot);
  } catch (e) {
    note(err, (e as Error).message);
    return WRAPPER_EXIT.wrapperError;
  }
  let runDirReal: string;
  try {
    runDirReal = await createRunDir(opts.runDir);
  } catch (e) {
    note(err, (e as Error).message);
    return WRAPPER_EXIT.wrapperError;
  }
  const paths = runDirPaths(runDirReal);
  const artifactId = newArtifactId(now());
  const before = gitState(located.projectRoot);

  // --- run once ----------------------------------------------------------------
  const live = opts.mode !== 'optimize';
  const proc = await (opts.runJestImpl ?? runJest)({
    located,
    jestArgs: opts.jestArgs,
    target: { stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath, jsonPath: paths.jsonPath },
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(live ? { onStdout: (c: Buffer) => opts.stdout.write(c), onStderr: (c: Buffer) => err.write(c) } : {}),
  });
  const after = gitState(located.projectRoot);
  const exit = wrapperExitCode(proc);
  let wrapperError: string | null = proc.spawnError ? `failed to start Jest: ${proc.spawnError}` : null;
  const captureErrors = [proc.stdout.writeError, proc.stderr.writeError].filter((x): x is string => !!x);
  if (captureErrors.length) wrapperError ??= `could not save test output: ${captureErrors.join('; ')}`;

  // --- read back what Jest wrote -------------------------------------------------
  let jsonBuf: Buffer | undefined;
  let jsonMissingReason: string | undefined;
  try {
    jsonBuf = await readRunFile(runDirReal, PART_FILES.result);
  } catch (e) {
    jsonMissingReason = (e as Error).message;
  }
  const stdoutBuf = proc.stdout.memoryComplete ? proc.stdout.memory : undefined;
  const stderrBuf = proc.stderr.memoryComplete ? proc.stderr.memory : undefined;

  // --- gate 1-3 and view -------------------------------------------------------------
  const gateChecks: GateCheck[] = [];
  let fallbackReason: string | null = null;
  let fallbackDetail: string | null = null;
  let view: JestView | undefined;
  const policyStatus = status?.status ?? 'n/a';
  if (policy) {
    const gate = evaluatePreRenderGate({
      policy,
      jestVersion: located.jestVersion,
      jsonText: jsonBuf?.toString('utf8'),
      ...(jsonMissingReason ? { jsonMissingReason } : {}),
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: proc.timedOut,
      cancelled: proc.cancelled,
      ...(proc.spawnError ? { spawnError: proc.spawnError } : {}),
      captureErrors: [
        ...captureErrors,
        ...(!stdoutBuf || !stderrBuf ? ['output larger than the in-memory view limit'] : []),
      ],
      stdoutUtf8: stdoutBuf ? isUtf8(stdoutBuf) : false,
      stderrUtf8: stderrBuf ? isUtf8(stderrBuf) : false,
    });
    gateChecks.push(...gate.checks);
    fallbackReason = gate.fallbackReason;
    fallbackDetail = gate.fallbackDetail;
    if (gate.parsed && stdoutBuf && stderrBuf) {
      try {
        view = renderJestView({
          result: gate.parsed,
          stdout: stdoutBuf.toString('utf8'),
          stderr: stderrBuf.toString('utf8'),
          rootDir: located.projectRoot,
          jsonPath: paths.jsonPath,
          process: {
            cwdDisplay: displayPath(located.projectRoot, process.cwd()),
            commandDisplay: redactText(['jest', ...opts.jestArgs].join(' ')),
            startedAt: proc.startedAt,
            durationMs: proc.durationMs,
            exitCode: proc.exitCode,
            signal: proc.signal,
            timedOut: proc.timedOut,
            cancelled: proc.cancelled,
            wrapperExitCode: exit.code,
          },
          artifactId,
          runDirDisplay: displayPath(runDirReal, process.cwd()),
          policy: { id: policy.id, status: policyStatus },
        });
      } catch (e) {
        fallbackReason ??= 'renderer_error';
        fallbackDetail ??= (e as Error).message;
        gateChecks.push({ check: 'render', passed: false, detail: (e as Error).message });
      }
    }
  }

  // --- persist view and verify artifact hashes (gate 4) ----------------------------
  const files: RunManifest['files'] = {};
  const notes: string[] = [];
  try {
    if (view) await writeNewFile(paths.viewPath, view.text);
    const expected: Partial<Record<StoredPart, Buffer | undefined>> = {
      stdout: stdoutBuf,
      stderr: stderrBuf,
      result: jsonBuf,
      view: view ? Buffer.from(view.text, 'utf8') : undefined,
    };
    let hashesOk = true;
    for (const part of Object.keys(PART_FILES) as StoredPart[]) {
      if (part === 'view' && !view) continue;
      if (part === 'result' && !jsonBuf) continue;
      const h = await hashFile(runDirReal, PART_FILES[part]).catch(() => undefined);
      if (!h) {
        hashesOk = false;
        continue;
      }
      files[part] = { file: PART_FILES[part], ...h };
      const mem = expected[part];
      if (mem && (sha256Hex(mem) !== h.sha256 || mem.length !== h.bytes)) hashesOk = false;
    }
    if (policy) {
      gateChecks.push({ check: 'artifacts.hash', passed: hashesOk, detail: hashesOk ? null : 'stored files do not match captured bytes' });
      if (!hashesOk) {
        fallbackReason ??= 'artifact_hash_mismatch';
        fallbackDetail ??= 'stored files do not match captured bytes';
      }
    }
    if (!hashesOk) wrapperError ??= 'artifact files could not be verified after writing';
  } catch (e) {
    wrapperError ??= `could not write artifacts: ${(e as Error).message}`;
    fallbackReason ??= 'artifact_write_error';
    fallbackDetail ??= (e as Error).message;
  }

  // --- gate 5: the view must be smaller than the raw output ---------------------------
  const rawBytes = proc.stdout.bytes + proc.stderr.bytes;
  const viewBytes = view ? Buffer.byteLength(view.text, 'utf8') : null;
  if (policy && view) {
    const smaller = viewBytes! < rawBytes;
    gateChecks.push({ check: 'size.smaller_than_raw', passed: smaller, detail: `view ${viewBytes} B vs raw ${rawBytes} B (bytes only; not a token measurement)` });
    if (!smaller) {
      fallbackReason ??= 'view_not_smaller';
      fallbackDetail ??= `view ${viewBytes} B >= raw ${rawBytes} B`;
    }
  }

  const useView = opts.mode === 'optimize' && !!view && fallbackReason === null && wrapperError === null;
  if (opts.mode === 'shadow') notes.push('shadow mode: raw output was returned; the view was generated for comparison only.');
  if (opts.mode === 'passthrough') notes.push('passthrough mode: raw output was returned; no view generated.');

  const finalExit = wrapperError ? WRAPPER_EXIT.wrapperError : exit.code;
  const manifest: RunManifest = {
    manifest_type: 'test-run',
    manifest_version: 1,
    artifact_id: artifactId,
    created_at: now().toISOString(),
    tool_version: TOOL_VERSION,
    runner: { name: 'jest', jest_version: located.jestVersion, node_version: process.version, platform: platform() },
    mode: opts.mode,
    policy: policy
      ? { id: policy.id, version: policy.version, hash: policyHash(policy), status: policyStatus, renderer: policy.renderer, renderer_version: policy.renderer_version }
      : null,
    command: {
      display: redactText(['jest', ...opts.jestArgs].join(' ')),
      jest_args: opts.jestArgs.map(redactText),
      wrapper_added_args: ['--json', '--outputFile=<run-dir>/jest-result.json'],
    },
    cwd_display: displayPath(located.projectRoot),
    started_at: proc.startedAt,
    ended_at: proc.endedAt,
    duration_ms: proc.durationMs,
    timeout_ms: opts.timeoutMs ?? null,
    exit: {
      jest_exit_code: proc.exitCode,
      signal: proc.signal,
      signal_mapping: exit.mapping,
      timed_out: proc.timedOut,
      cancelled: proc.cancelled,
      spawn_error: proc.spawnError ?? null,
      wrapper_exit_code: finalExit,
      wrapper_error: wrapperError,
    },
    snapshot: {
      git_head: before.head,
      dirty_before: before.dirty,
      dirty_after: after.dirty,
      note: 'Git state only; dependencies, databases and environment may still differ between runs.',
    },
    files,
    output: {
      returned: useView ? 'structured_view' : 'raw',
      fallback_reason: opts.mode === 'optimize' ? (useView ? null : (fallbackReason ?? 'wrapper_error')) : null,
      fallback_detail: opts.mode === 'optimize' && !useView ? (fallbackDetail ?? wrapperError) : null,
      gate: gateChecks,
      raw_bytes: rawBytes,
      view_bytes: viewBytes,
      omitted: view?.omitted ?? [],
    },
    notes,
  };

  let manifestOk = true;
  try {
    await writeNewFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (e) {
    manifestOk = false;
    note(err, `could not write ${MANIFEST_FILE}: ${(e as Error).message}`);
  }

  // --- output --------------------------------------------------------------------------
  if (opts.mode === 'optimize') {
    if (useView && manifestOk) {
      opts.stdout.write(view!.text);
    } else {
      try {
        await emitRaw(opts.stdout, proc.stdout.memory, proc.stdout.memoryComplete, paths.stdoutPath);
        await emitRaw(err, proc.stderr.memory, proc.stderr.memoryComplete, paths.stderrPath);
      } catch (e) {
        note(err, `could not return raw output: ${(e as Error).message}`);
        return WRAPPER_EXIT.wrapperError;
      }
      note(err, `returned raw output (fallback: ${manifest.output.fallback_reason}${manifest.output.fallback_detail ? ` — ${manifest.output.fallback_detail}` : ''}); tests were not re-run`);
    }
  }
  if (wrapperError) note(err, `wrapper error (not a test result): ${wrapperError}; Jest exit code was ${proc.exitCode ?? 'n/a'}`);
  if (proc.timedOut) note(err, `timed out after ${opts.timeoutMs} ms; this is not a passing result`);
  if (proc.cancelled) note(err, `cancelled by ${proc.cancelled}; this is not a passing result`);
  if (opts.mode !== 'optimize' || !useView) note(err, `artifact ${artifactId} saved in ${displayPath(runDirReal, process.cwd())} (mode ${opts.mode})`);
  if (!manifestOk) return WRAPPER_EXIT.wrapperError;
  return finalExit;
}

export { ArtifactError, RunnerSetupError };
