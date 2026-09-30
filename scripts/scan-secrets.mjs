// Scans every git-tracked file with ACR's own privacy guard (secret patterns + personal data).
// Run in CI so this repository gets the same protection ACR gives its users. Needs a build first.
// Test files and the detector sources contain deliberate fake secrets and are skipped.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { DEFAULT_PRIVACY, PrivacyGuard } from '@acr/security/privacy.js';

const ALLOW = [
  'test/**',
  'packages/*/test/**',
  'packages/security/src/redact.ts',
  'packages/security/src/privacy.ts',
  'fixtures/**',
  // Lockfiles list package authors' public emails and integrity hashes.
  '**/pnpm-lock.yaml',
  'pnpm-lock.yaml',
];

const files = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', shell: false }).stdout.split('\0').filter(Boolean);
// No .env discovery here: the repository must not contain real .env files at all.
const guard = new PrivacyGuard(process.cwd(), { ...DEFAULT_PRIVACY, envFiles: false });
const findings = [];
for (const f of files) {
  if (ALLOW.some((g) => posix.matchesGlob(f, g))) continue;
  if (/(^|\/)\.env(\..+)?$/.test(f) && !/\.(example|sample|template)$/.test(f)) {
    findings.push(`${f}: a .env file is committed`);
    continue;
  }
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue; // binary
  const { report } = guard.filter({ text });
  const hits = Object.entries(report.masked);
  if (hits.length) findings.push(`${f}: ${hits.map(([k, n]) => `${k}×${n}`).join(', ')}`);
}

if (findings.length) {
  process.stderr.write(`Possible secrets or personal data in tracked files:\n${findings.map((x) => `  ${x}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`secret scan: ok (${files.length} tracked files)\n`);
