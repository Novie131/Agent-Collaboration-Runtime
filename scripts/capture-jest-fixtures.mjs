#!/usr/bin/env node
// Captures REAL Jest output (from the synthetic test code in examples/jest-sample)
// through `acr test --mode shadow`, de-identifies paths and stores it
// under fixtures/real/jest-<version>/<scenario>/. Requires `pnpm build` and an
// installed examples/jest-sample (pnpm --dir examples/jest-sample install).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sample = realpathSync(join(repo, 'examples', 'jest-sample'));
const cli = join(repo, 'dist', 'cli.js');
const jestVersion = JSON.parse(readFileSync(join(sample, 'node_modules', 'jest', 'package.json'), 'utf8')).version;

// A larger project shape: many small suites, generated deterministically (git-ignored).
const manyDir = join(sample, 'scenarios', 'generated-many');
rmSync(manyDir, { recursive: true, force: true });
mkdirSync(manyDir, { recursive: true });
for (let i = 0; i < 120; i++) {
  const n = String(i).padStart(3, '0');
  const failing = i === 57;
  writeFileSync(
    join(manyDir, `module-${n}.test.js`),
    `const { sum } = require('../../src/math');\n` +
      `describe('module ${n}', () => {\n` +
      `  test('adds', () => expect(sum(${i}, 1)).toBe(${failing ? i + 2 : i + 1}));\n` +
      `  test('identity', () => expect(sum(${i}, 0)).toBe(${i}));\n` +
      `  test('commutes', () => expect(sum(1, ${i})).toBe(sum(${i}, 1)));\n` +
      `});\n`,
  );
}

const scenarios = [
  { name: 'many-suites', args: ['scenarios/generated-many'] },
  { name: 'many-suites-verbose', args: ['scenarios/generated-many', '--verbose'] },
  { name: 'pass', args: ['scenarios/pass'] },
  { name: 'pass-verbose', args: ['scenarios/pass', '--verbose'] },
  { name: 'fail', args: ['scenarios/fail'] },
  { name: 'fail-verbose', args: ['scenarios/fail', '--verbose'] },
  { name: 'mixed', args: ['scenarios/mixed', '--ci'] },
  { name: 'console', args: ['scenarios/console'] },
  { name: 'runtime-error', args: ['scenarios/runtime-error'] },
  { name: 'all', args: ['--testPathIgnorePatterns', 'generated-many'] },
];

const work = mkdtempSync(join(tmpdir(), 'ae-capture-'));
const outRoot = join(repo, 'fixtures', 'real', `jest-${jestVersion}`);
rmSync(outRoot, { recursive: true, force: true });

const workReal = realpathSync(work);
const deidentify = (s) =>
  s.split(sample).join('<ROOT>').split(workReal).join('<RUN>').split(work).join('<RUN>').split(homedir()).join('~');

for (const sc of scenarios) {
  const runDir = join(work, sc.name);
  const res = spawnSync(process.execPath, [cli, 'test', '--mode', 'shadow', '--project-root', sample, '--run-dir', runDir, '--', ...sc.args], {
    cwd: repo,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, CI: '', FORCE_COLOR: '0' },
  });
  const dest = join(outRoot, sc.name);
  mkdirSync(dest, { recursive: true });
  for (const f of ['stdout.log', 'stderr.log', 'jest-result.json']) {
    let text;
    try {
      text = readFileSync(join(runDir, f), 'utf8');
    } catch {
      continue;
    }
    writeFileSync(join(dest, f), deidentify(text));
  }
  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
  writeFileSync(
    join(dest, 'meta.json'),
    `${JSON.stringify(
      {
        kind: 'real Jest output of synthetic test code (examples/jest-sample); absolute paths replaced by <ROOT>/<RUN>/~',
        jest_version: jestVersion,
        node_version: process.version,
        platform: process.platform,
        jest_args: sc.args,
        wrapper_exit_code: res.status,
        jest_exit_code: manifest.exit.jest_exit_code,
        shadow_gate: manifest.output.gate,
        raw_bytes: manifest.output.raw_bytes,
        view_bytes: manifest.output.view_bytes,
        captured_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  if (manifest.files.view) cpSync(join(runDir, 'view.txt'), join(dest, 'view.txt'));
  const v = readFileSync(join(dest, 'meta.json'), 'utf8');
  writeFileSync(join(dest, 'meta.json'), deidentify(v));
  try {
    writeFileSync(join(dest, 'view.txt'), deidentify(readFileSync(join(dest, 'view.txt'), 'utf8')));
  } catch {}
  console.log(`${sc.name}: wrapper exit ${res.status}, jest exit ${manifest.exit.jest_exit_code}, raw ${manifest.output.raw_bytes} B, view ${manifest.output.view_bytes ?? '-'} B`);
}
rmSync(work, { recursive: true, force: true });
console.log(`fixtures written to ${outRoot}`);
