import { z } from 'zod';

export const ARTIFACT_ID_RE = /^ae_\d{14}_[0-9a-f]{8}$/;

/** Fixed file names inside a run directory. Artifact IDs never map to paths directly. */
export const PART_FILES = {
  stdout: 'stdout.log',
  stderr: 'stderr.log',
  result: 'jest-result.json',
  view: 'view.txt',
} as const;
export type StoredPart = keyof typeof PART_FILES;
export const MANIFEST_FILE = 'manifest.json';

const FileEntry = z.object({ file: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() }).strict();

export const RunManifest = z
  .object({
    manifest_type: z.literal('test-run'),
    manifest_version: z.literal(1),
    artifact_id: z.string().regex(ARTIFACT_ID_RE),
    created_at: z.string(),
    tool_version: z.string(),
    runner: z.object({ name: z.literal('jest'), jest_version: z.string(), node_version: z.string(), platform: z.string() }).strict(),
    mode: z.enum(['shadow', 'optimize', 'passthrough']),
    policy: z
      .object({ id: z.string(), version: z.string(), hash: z.string(), status: z.string(), renderer: z.string(), renderer_version: z.string() })
      .strict()
      .nullable(),
    command: z.object({ display: z.string(), jest_args: z.array(z.string()), wrapper_added_args: z.array(z.string()) }).strict(),
    cwd_display: z.string(),
    started_at: z.string(),
    ended_at: z.string(),
    duration_ms: z.number(),
    timeout_ms: z.number().nullable(),
    exit: z
      .object({
        jest_exit_code: z.number().nullable(),
        signal: z.string().nullable(),
        signal_mapping: z.string().nullable(),
        timed_out: z.boolean(),
        cancelled: z.string().nullable(),
        spawn_error: z.string().nullable(),
        wrapper_exit_code: z.number(),
        wrapper_error: z.string().nullable(),
      })
      .strict(),
    snapshot: z
      .object({
        git_head: z.string().nullable(),
        dirty_before: z.boolean().nullable(),
        dirty_after: z.boolean().nullable(),
        note: z.string(),
      })
      .strict(),
    files: z.record(z.enum(['stdout', 'stderr', 'result', 'view']), FileEntry),
    output: z
      .object({
        returned: z.enum(['structured_view', 'raw']),
        fallback_reason: z.string().nullable(),
        fallback_detail: z.string().nullable(),
        gate: z.array(z.object({ check: z.string(), passed: z.boolean(), detail: z.string().nullable() }).strict()),
        raw_bytes: z.number(),
        view_bytes: z.number().nullable(),
        omitted: z.array(z.object({ kind: z.string(), count: z.number(), expand: z.string() }).strict()),
      })
      .strict(),
    notes: z.array(z.string()),
  })
  .strict();
export type RunManifest = z.infer<typeof RunManifest>;
