/**
 * Jest arguments the wrapper refuses. Everything else is passed through
 * unchanged, in order, as separate argv entries (never joined into a shell string).
 */
export const DENIED_JEST_ARGS: { flag: string; reason: string }[] = [
  { flag: '--watch', reason: 'watch mode is interactive and never finishes' },
  { flag: '--watchAll', reason: 'watch mode is interactive and never finishes' },
  { flag: '--json', reason: 'the wrapper sets its own structured reporter output' },
  { flag: '--outputFile', reason: 'the wrapper writes the structured result into the run directory' },
  { flag: '--testResultsProcessor', reason: 'rewrites the structured result the view is built from' },
  { flag: '--listTests', reason: 'does not run tests' },
  { flag: '--showConfig', reason: 'does not run tests' },
  { flag: '--init', reason: 'does not run tests' },
  { flag: '--clearCache', reason: 'does not run tests' },
  { flag: '--help', reason: 'does not run tests' },
  { flag: '-h', reason: 'does not run tests' },
  { flag: '--version', reason: 'does not run tests' },
  { flag: '-v', reason: 'does not run tests' },
];

export interface ArgCheck {
  ok: boolean;
  denied: { arg: string; reason: string }[];
}

export function checkJestArgs(args: string[]): ArgCheck {
  const denied: ArgCheck['denied'] = [];
  for (const arg of args) {
    const name = arg.startsWith('--') ? arg.split('=')[0]! : arg;
    // Jest (yargs) also accepts kebab-case and --no-<flag> forms.
    const negated = name.startsWith('--no-');
    const normalised = name.startsWith('--')
      ? `--${name.slice(negated ? 5 : 2).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())}`
      : name;
    const hit = DENIED_JEST_ARGS.find((d) => d.flag === name || d.flag === normalised);
    // --no-watch / --no-watchAll only turn watch mode off, which is fine.
    if (hit && !(negated && (hit.flag === '--watch' || hit.flag === '--watchAll'))) {
      denied.push({ arg, reason: hit.reason });
    }
  }
  return { ok: denied.length === 0, denied };
}
