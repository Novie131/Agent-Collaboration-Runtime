// Builds every workspace package with tsc in dependency order (no shell, no pnpm on PATH needed).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');

const pkgs = new Map();
for (const group of ['packages', 'apps']) {
  const base = join(root, group);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    const file = join(dir, 'package.json');
    if (!existsSync(file) || !existsSync(join(dir, 'tsconfig.build.json'))) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    pkgs.set(pkg.name, { dir, deps: Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@acr/')) });
  }
}

const order = [];
const state = new Map();
const visit = (name, trail) => {
  if (state.get(name) === 'done') return;
  if (state.get(name) === 'visiting') throw new Error(`dependency cycle: ${[...trail, name].join(' -> ')}`);
  state.set(name, 'visiting');
  for (const d of pkgs.get(name)?.deps ?? []) if (pkgs.has(d)) visit(d, [...trail, name]);
  state.set(name, 'done');
  order.push(name);
};
for (const name of [...pkgs.keys()].sort()) visit(name, []);

for (const name of order) {
  const { dir } = pkgs.get(name);
  rmSync(join(dir, 'dist'), { recursive: true, force: true });
  const r = spawnSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.build.json')], { stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    process.stderr.write(`build failed: ${name}\n`);
    process.exit(r.status ?? 1);
  }
  process.stdout.write(`built ${name}\n`);
}
