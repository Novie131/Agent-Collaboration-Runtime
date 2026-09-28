#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { listAdapterInfo } from './adapters/index.js';
import { InvalidInputError } from './adapters/types.js';
import { EXPAND_PARTS, expandArtifact, type ExpandPart } from './artifacts/expand.js';
import { parseAge, prune } from './artifacts/prune.js';
import { ArtifactError } from './artifacts/store.js';
import { runCompare } from './evaluate/run-compare.js';
import { analyze } from './observe/analyze.js';
import { POLICIES, policyHash } from './policies/registry.js';
import { effectiveStatus } from './policies/state.js';
import { DENIED_JEST_ARGS } from './runner/jest-args.js';
import { runTestCommand, WRAPPER_EXIT, type TestMode } from './runner/test-command.js';
import { TOOL_VERSION } from './version.js';

/** analyze / compare exit codes (spec §15). */
const EXIT = { ok: 0, io: 1, invalid: 2 } as const;

const positiveInt = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError('must be a positive integer');
  return n;
};

function reportError(err: unknown): number {
  if (err instanceof InvalidInputError) {
    process.stderr.write(`agent-efficiency: invalid input: ${err.message}\n`);
    return EXIT.invalid;
  }
  process.stderr.write(`agent-efficiency: ${(err as Error).message}\n`);
  return EXIT.io;
}

export function buildProgram(setExit: (code: number) => void): Command {
  const program = new Command();
  program
    .name('agent-efficiency')
    .description('Quality-first token optimisation tooling for coding agents (local, offline, no telemetry).')
    .version(TOOL_VERSION)
    .enablePositionalOptions()
    .showHelpAfterError();

  program
    .command('analyze')
    .description('Diagnose candidate waste (R001–R004) and token usage in one explicitly given session log.')
    .argument('<input>', 'session JSONL file (never discovered automatically)')
    .addOption(new Option('--adapter <id>', 'input format').default('canonical'))
    .requiredOption('--out-dir <dir>', 'report directory (analysis.json, analysis.md)')
    .option('--strict', 'fail on the first malformed line', false)
    .option('--overwrite', 'replace existing report files', false)
    .option('--config <file>', 'rule thresholds as plain JSON')
    .option('--max-line-bytes <n>', 'skip lines longer than this', positiveInt)
    .option('--project-root <dir>', 'show paths relative to this directory')
    .action(async (input: string, o: { adapter: string; outDir: string; strict: boolean; overwrite: boolean; config?: string; maxLineBytes?: number; projectRoot?: string }) => {
      try {
        const { report, written } = await analyze({
          input,
          adapter: o.adapter,
          outDir: o.outDir,
          strict: o.strict,
          overwrite: o.overwrite,
          ...(o.config ? { configPath: o.config } : {}),
          ...(o.maxLineBytes ? { maxLineBytes: o.maxLineBytes } : {}),
          ...(o.projectRoot ? { projectRoot: o.projectRoot } : {}),
        });
        process.stdout.write(
          `${report.findings.length} candidate finding(s); usage ${report.usage.completeness}` +
            `${report.coverage.partial ? `; PARTIAL input (${report.coverage.skipped.length} line(s) skipped)` : ''}\n` +
            written.map((w) => `wrote ${w}\n`).join(''),
        );
        setExit(EXIT.ok);
      } catch (err) {
        setExit(reportError(err));
      }
    });

  program
    .command('test')
    .description('Run the project\'s own Jest once, save raw artifacts, and return raw output or a checked structured view.')
    .addOption(new Option('--mode <mode>', 'shadow | optimize | passthrough').choices(['shadow', 'optimize', 'passthrough']).default('shadow'))
    .option('--policy <id>', 'view policy (optimize requires it; shadow defaults to jest-v1)')
    .option('--allow-experimental', 'allow an experimental policy in optimize mode', false)
    .option('--project-root <dir>', 'project containing package.json and node_modules/jest', '.')
    .requiredOption('--run-dir <dir>', 'new directory for this run\'s artifacts')
    .option('--timeout-ms <n>', 'wrapper wall-clock limit (same value must be used for baseline and optimized runs)', positiveInt)
    .argument('[jestArgs...]', 'arguments passed to Jest after --')
    .passThroughOptions()
    .addHelpText('after', `\nRefused Jest arguments:\n${DENIED_JEST_ARGS.map((d) => `  ${d.flag.padEnd(24)} ${d.reason}`).join('\n')}\nAll other arguments are passed to Jest unchanged as an argv array (no shell).\n\nExit status: Jest's own exit code; 128+n when Jest is killed by signal n; 124 on wrapper timeout;\n125 for wrapper errors (setup, refused arguments, artifact write failures) — never 0 unless Jest exited 0 and artifacts were saved.`)
    .action(async (jestArgs: string[], o: { mode: TestMode; policy?: string; allowExperimental: boolean; projectRoot: string; runDir: string; timeoutMs?: number }) => {
      try {
        const code = await runTestCommand({
          mode: o.mode,
          ...(o.policy ? { policyId: o.policy } : {}),
          allowExperimental: o.allowExperimental,
          projectRoot: o.projectRoot,
          runDir: o.runDir,
          jestArgs,
          ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
          stdout: process.stdout,
          stderr: process.stderr,
        });
        setExit(code);
      } catch (err) {
        process.stderr.write(`[agent-efficiency] wrapper error (not a test result): ${(err as Error).message}\n`);
        setExit(WRAPPER_EXIT.wrapperError);
      }
    });

  program
    .command('expand')
    .description('Show a stored part of a test-run artifact. Reads files only; never re-runs anything.')
    .argument('<artifact-id>')
    .requiredOption('--run-dir <dir>', 'run directory that holds the artifact')
    .addOption(new Option('--part <part>', 'part to show').choices([...EXPAND_PARTS]).default('view'))
    .option('--raw', 'original bytes without masking', false)
    .option('--project-root <dir>', 'show test paths relative to this directory (default: current directory)')
    .action(async (artifactId: string, o: { runDir: string; part: ExpandPart; raw: boolean; projectRoot?: string }) => {
      try {
        await expandArtifact({ artifactId, runDir: o.runDir, part: o.part, raw: o.raw, stdout: process.stdout, stderr: process.stderr, ...(o.projectRoot ? { projectRoot: o.projectRoot } : {}) });
        setExit(EXIT.ok);
      } catch (err) {
        if (err instanceof ArtifactError) {
          process.stderr.write(`agent-efficiency: ${err.message}\n`);
          setExit(err.code === 'invalid_id' ? EXIT.invalid : EXIT.io);
        } else setExit(reportError(err));
      }
    });

  program
    .command('compare')
    .description('Offline paired comparison of completed runs with quality gates (reads manifests only; calls no agent or API).')
    .argument('<experiment>', 'experiment manifest JSON')
    .requiredOption('--out-dir <dir>', 'report directory (comparison.json, comparison.md)')
    .option('--overwrite', 'replace existing report files', false)
    .action(async (experiment: string, o: { outDir: string; overwrite: boolean }) => {
      try {
        const { report, written } = await runCompare({ experiment, outDir: o.outDir, overwrite: o.overwrite });
        process.stdout.write(`primary verdict: ${report.primary_verdict}${report.synthetic ? ' (SYNTHETIC data)' : ''}\n${written.map((w) => `wrote ${w}\n`).join('')}`);
        setExit(EXIT.ok);
      } catch (err) {
        setExit(reportError(err));
      }
    });

  program
    .command('policies')
    .description('List output policies and their status.')
    .option('--json', 'machine-readable output', false)
    .action((o: { json: boolean }) => {
      const rows = Object.values(POLICIES).map((p) => ({ ...p, hash: policyHash(p), effective: effectiveStatus({ policyId: p.id, disabled: false }) }));
      if (o.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      else {
        for (const r of rows) {
          process.stdout.write(`${r.id} v${r.version}  status: ${r.effective.status} (${r.effective.reason})\n  ${r.description}\n  renderer ${r.renderer}@${r.renderer_version} · ${r.hash}\n  verified Jest: ${r.verified_jest_versions.join(', ') || 'none'}\n  omits: ${r.omits.join('; ')}\n  never omits: ${r.never_omits.join('; ')}\n`);
        }
      }
      setExit(EXIT.ok);
    });

  program
    .command('adapters')
    .description('List input adapters, their support status and what was actually verified.')
    .option('--json', 'machine-readable output', false)
    .action((o: { json: boolean }) => {
      const rows = listAdapterInfo();
      if (o.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      else {
        for (const a of rows) {
          process.stdout.write(`${a.id}  [${a.status}]  ${a.host}\n  tested: ${a.tested_versions.join(', ') || 'none'}\n  usage: ${a.usage_semantics}\n  limitations: ${a.limitations.join(' | ')}\n`);
        }
      }
      setExit(EXIT.ok);
    });

  program
    .command('prune')
    .description('List (default) or delete run directories under a root that are older than a given age.')
    .requiredOption('--root <dir>', 'directory containing run directories')
    .requiredOption('--older-than <age>', 'e.g. 12h, 7d')
    .option('--apply', 'actually delete (default is a dry run)', false)
    .action(async (o: { root: string; olderThan: string; apply: boolean }) => {
      try {
        const { candidates, deleted } = await prune(o.root, parseAge(o.olderThan), o.apply);
        for (const c of candidates) process.stdout.write(`${o.apply ? 'deleted' : 'would delete'} ${c.runDir} (${c.artifactId}, ${c.createdAt})\n`);
        if (!o.apply) process.stdout.write(`dry run: ${candidates.length} run dir(s); pass --apply to delete\n`);
        else process.stdout.write(`${deleted.length} run dir(s) deleted\n`);
        setExit(EXIT.ok);
      } catch (err) {
        setExit(reportError(err));
      }
    });

  return program;
}

async function main() {
  let code = 0;
  const program = buildProgram((c) => {
    code = c;
  });
  program.exitOverride();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help') code = 0;
      else code = process.argv[2] === 'test' ? WRAPPER_EXIT.wrapperError : EXIT.invalid;
    } else {
      process.stderr.write(`agent-efficiency: ${(err as Error).message}\n`);
      code = EXIT.io;
    }
  }
  process.exitCode = code;
}

void main();
