import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';

export class RunnerSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerSetupError';
  }
}

export interface LocatedJest {
  projectRoot: string;
  jestVersion: string;
  jestBin: string;
}

/** Finds the project's own locally installed Jest. Never downloads or installs anything. */
export async function locateJest(projectRootInput: string): Promise<LocatedJest> {
  let projectRoot: string;
  try {
    projectRoot = await realpath(projectRootInput);
  } catch {
    throw new RunnerSetupError(`project root not found: ${projectRootInput}`);
  }
  const pkgStat = await stat(join(projectRoot, 'package.json')).catch(() => undefined);
  if (!pkgStat?.isFile()) throw new RunnerSetupError(`no package.json in project root ${projectRootInput}`);

  const jestPkgPath = join(projectRoot, 'node_modules', 'jest', 'package.json');
  let jestPkg: { version?: unknown; bin?: unknown };
  try {
    jestPkg = JSON.parse(await readFile(jestPkgPath, 'utf8')) as typeof jestPkg;
  } catch {
    throw new RunnerSetupError(
      'Jest is not installed in this project (expected node_modules/jest). Install it with the project\'s package manager; agent-efficiency never installs it.',
    );
  }
  if (typeof jestPkg.version !== 'string') throw new RunnerSetupError('node_modules/jest/package.json has no version');
  const binField = typeof jestPkg.bin === 'string' ? jestPkg.bin : (jestPkg.bin as Record<string, string> | undefined)?.jest;
  if (typeof binField !== 'string') throw new RunnerSetupError('cannot find the jest executable in node_modules/jest/package.json');
  const jestDir = await realpath(join(projectRoot, 'node_modules', 'jest'));
  const jestBin = join(jestDir, binField);
  const binStat = await stat(jestBin).catch(() => undefined);
  if (!binStat?.isFile()) throw new RunnerSetupError(`jest executable missing: ${binField}`);
  return { projectRoot, jestVersion: jestPkg.version, jestBin };
}

export interface CaptureTarget {
  stdoutPath: string;
  stderrPath: string;
  jsonPath: string;
}

export interface RunJestOptions {
  located: LocatedJest;
  jestArgs: string[];
  target: CaptureTarget;
  timeoutMs?: number;
  killGraceMs?: number;
  /** Live copy of child output (passthrough/shadow). Optimize mode leaves these unset. */
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  /** Keep an in-memory copy up to this many bytes per stream, in case the disk write fails. */
  memoryCopyLimit?: number;
  /** Test seam: replaces fs.createWriteStream. */
  createStream?: (path: string) => WriteStream;
  env?: NodeJS.ProcessEnv;
}

export interface StreamCapture {
  bytes: number;
  writeError?: string;
  memory?: Buffer;
  memoryComplete: boolean;
}

export interface JestProcessResult {
  argv: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: NodeJS.Signals | null;
  spawnError?: string;
  stdout: StreamCapture;
  stderr: StreamCapture;
}

const openCaptureStream = (path: string) => createWriteStream(path, { flags: 'wx', mode: 0o600 });

function capture(
  source: NodeJS.ReadableStream,
  path: string,
  make: (p: string) => WriteStream,
  memoryLimit: number,
  onChunk?: (c: Buffer) => void,
) {
  const state: StreamCapture = { bytes: 0, memoryComplete: true };
  const memory: Buffer[] = [];
  let memBytes = 0;
  const out = make(path);
  const done = new Promise<void>((resolve) => {
    out.on('error', (err) => {
      state.writeError ??= (err as Error).message;
      resolve();
    });
    out.on('close', () => resolve());
  });
  source.on('data', (chunk: Buffer) => {
    state.bytes += chunk.length;
    if (memBytes + chunk.length <= memoryLimit) {
      memory.push(chunk);
      memBytes += chunk.length;
    } else {
      state.memoryComplete = false;
    }
    onChunk?.(chunk);
    if (!state.writeError) out.write(chunk);
  });
  let ended = false;
  const endOut = () => {
    if (ended) return;
    ended = true;
    out.end();
  };
  source.on('end', endOut);
  source.on('close', endOut);
  return {
    state,
    finished: done.then(() => {
      state.memory = Buffer.concat(memory, memBytes);
      return state;
    }),
  };
}

/** Maps a terminating signal to the conventional 128+n exit status. */
export function signalExitCode(signal: NodeJS.Signals): number {
  const n = (osConstants.signals as Record<string, number>)[signal];
  return 128 + (n ?? 0);
}

export async function runJest(opts: RunJestOptions): Promise<JestProcessResult> {
  const argv = [opts.located.jestBin, ...opts.jestArgs, '--json', `--outputFile=${opts.target.jsonPath}`];
  const started = new Date();
  const make = opts.createStream ?? openCaptureStream;
  const memoryLimit = opts.memoryCopyLimit ?? 64 * 1024 * 1024;
  const posix = process.platform !== 'win32';

  const child = spawn(process.execPath, argv, {
    cwd: opts.located.projectRoot,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env ?? process.env,
    // Own process group so timeout/cancel can stop Jest workers too.
    detached: posix,
    windowsHide: true,
  });

  let timedOut = false;
  let cancelled: NodeJS.Signals | null = null;
  let spawnError: string | undefined;

  const killTree = (sig: NodeJS.Signals) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (posix) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  const grace = opts.killGraceMs ?? 5000;
  let graceTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    killTree('SIGTERM');
    graceTimer = setTimeout(() => killTree('SIGKILL'), grace);
    graceTimer.unref();
  };
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        terminate();
      }, opts.timeoutMs)
    : undefined;

  const onSignal = (sig: NodeJS.Signals) => {
    cancelled ??= sig;
    terminate();
  };
  const sigHandlers: [NodeJS.Signals, () => void][] = (['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]).map((s) => [s, () => onSignal(s)]);
  for (const [s, h] of sigHandlers) process.on(s, h);

  const out = capture(child.stdout!, opts.target.stdoutPath, make, memoryLimit, opts.onStdout);
  const err = capture(child.stderr!, opts.target.stderrPath, make, memoryLimit, opts.onStderr);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('error', (e) => {
      spawnError = e.message;
      resolve({ code: null, signal: null });
    });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  if (timer) clearTimeout(timer);
  if (graceTimer) clearTimeout(graceTimer);
  for (const [s, h] of sigHandlers) process.off(s, h);
  if (spawnError) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  const [stdout, stderr] = await Promise.all([out.finished, err.finished]);
  const ended = new Date();
  return {
    argv: [process.execPath, ...argv],
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    durationMs: ended.getTime() - started.getTime(),
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    cancelled,
    ...(spawnError ? { spawnError } : {}),
    stdout,
    stderr,
  };
}
