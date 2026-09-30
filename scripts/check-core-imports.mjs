// SPEC §9.3 / ADR-0002: core packages stay offline. Fails if a core package imports networking,
// process spawning, the MCP SDK, or any edge package.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Edge packages may use the network or start agents (opt-in). Everything else under packages/ is core. */
export const EDGE_PACKAGES = new Set(['runner', 'mcp', 'git', 'remote-bridge', 'claude-sdk', 'daemon']);
const FORBIDDEN_MODULES = [
  /^(node:)?(http|https|http2|net|tls|dgram|child_process|cluster|worker_threads)$/,
  /^@modelcontextprotocol\//,
  /^@anthropic-ai\//,
  /^openai$/,
];
const edgeImport = (spec) => {
  const m = /^@acr\/([^/]+)/.exec(spec);
  return m ? EDGE_PACKAGES.has(m[1]) || m[1] === 'cli' : false;
};

const importRe = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)(['"])([^'"]+)\1/g;
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|mts|js|mjs)$/.test(n) ? [p] : [];
  });

const problems = [];
const pkgRoot = join(root, 'packages');
for (const name of readdirSync(pkgRoot)) {
  if (EDGE_PACKAGES.has(name)) continue;
  const dir = join(pkgRoot, name);
  const pkgFile = join(dir, 'package.json');
  if (!existsSync(pkgFile)) continue;
  const deps = Object.keys(JSON.parse(readFileSync(pkgFile, 'utf8')).dependencies ?? {});
  for (const d of deps) if (edgeImport(d) || FORBIDDEN_MODULES.some((re) => re.test(d))) problems.push(`${relative(root, pkgFile)}: depends on ${d}`);
  const src = join(dir, 'src');
  if (!existsSync(src)) continue;
  for (const file of walk(src)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(importRe)) {
      const spec = m[2];
      if (edgeImport(spec) || FORBIDDEN_MODULES.some((re) => re.test(spec))) problems.push(`${relative(root, file)}: imports ${spec}`);
    }
  }
}

if (problems.length) {
  process.stderr.write(`Core packages must stay offline (SPEC §9.3):\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('core import check: ok\n');
