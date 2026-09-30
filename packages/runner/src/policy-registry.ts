import { sha256Hex } from '@acr/artifacts/store.js';
import { RENDERER_ID, RENDERER_VERSION } from '@acr/compression/jest-view.js';

export interface PolicyDefinition {
  id: string;
  version: string;
  description: string;
  renderer: string;
  renderer_version: string;
  default_status: 'experimental';
  /** Jest majors whose JSON output has been checked against real fixtures (fixtures/real/). */
  verified_jest_majors: number[];
  verified_jest_versions: string[];
  omits: string[];
  never_omits: string[];
}

export const JEST_V1: PolicyDefinition = {
  id: 'jest-v1',
  version: '1.0.0',
  description: 'Structured Jest result view: all failures verbatim, passed-test names and verified reporter duplicates summarised.',
  renderer: RENDERER_ID,
  renderer_version: RENDERER_VERSION,
  default_status: 'experimental',
  verified_jest_majors: [29],
  verified_jest_versions: ['29.7.0'],
  omits: [
    'names of passed tests',
    'stderr reporter lines verified against the JSON result (PASS/FAIL headers, summary counts, verbose test-name lines)',
    'stderr failure blocks byte-identical to the suite messages shown in the view',
    'raw failureMessages / failureDetails (the formatted suite message is shown instead)',
    'per-test durations',
  ],
  never_omits: [
    'any failed test and its formatted failure message, stack and diff',
    'stderr lines not verified as reporter duplicates (warnings, console output, open handles)',
    'stdout',
    'exit code / signal / timeout / cancellation',
    'skipped / todo test names',
  ],
};

export const POLICIES: Record<string, PolicyDefinition> = { [JEST_V1.id]: JEST_V1 };

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

export const policyHash = (p: PolicyDefinition) => `sha256:${sha256Hex(stable(p))}`;
