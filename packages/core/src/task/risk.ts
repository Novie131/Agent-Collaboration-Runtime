import { posix } from 'node:path';
import { RISK_ORDER, type Risk } from '@acr/protocol/collaboration.js';
import { DEFAULT_HIGH_RISK_GLOBS, DEFAULT_LOW_RISK_GLOBS, type WorkspaceConfig } from '../config.js';

const DESTRUCTIVE_HINTS = /\b(delet(e|ion)|drop|truncate|purge|breaking|remove (the )?public)\b/i;

export const matchesAny = (path: string, globs: readonly string[]) => {
  // Globs are matched on forward-slash paths; `**/x/**` should also match `x/...` at the root.
  const p = path.replace(/\\/g, '/');
  return globs.some((g) => posix.matchesGlob(p, g) || (g.startsWith('**/') && posix.matchesGlob(p, g.slice(3))));
};

/**
 * Minimum risk implied by paths and constraints (SPEC §17.2). Paths may be files or directory
 * prefixes (`src/auth/`), so a directory is also tested as if it contained a file.
 */
export function minimumRisk(
  paths: readonly string[],
  constraints: readonly string[],
  rules: WorkspaceConfig['risk_rules'],
): { risk: Risk; reasons: string[] } {
  const high = rules.high ?? DEFAULT_HIGH_RISK_GLOBS;
  const low = rules.low ?? DEFAULT_LOW_RISK_GLOBS;
  const reasons: string[] = [];
  const probe = (p: string) => (p.endsWith('/') ? [p, `${p}x`] : [p, `${p}/x`]);

  for (const p of paths) {
    if (probe(p).some((q) => matchesAny(q, high))) reasons.push(`path ${p} matches a high-risk rule`);
  }
  for (const c of constraints) {
    if (DESTRUCTIVE_HINTS.test(c)) reasons.push(`constraint mentions a destructive or breaking change: "${c.slice(0, 80)}"`);
  }
  if (reasons.length) return { risk: 'high', reasons };

  const allLow = paths.length > 0 && paths.every((p) => matchesAny(p.endsWith('/') ? `${p}x` : p, low));
  if (allLow) return { risk: 'low', reasons: [] };
  return { risk: 'medium', reasons: paths.length ? ['paths outside documentation'] : [] };
}

export const maxRisk = (a: Risk, b: Risk): Risk => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b);
