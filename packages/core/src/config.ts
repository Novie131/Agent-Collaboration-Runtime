import { z } from 'zod';

/** `.agent-runtime/config.json` (SPEC §23.2). Every field has a default so a minimal file works. */
export const WorkspaceConfig = z
  .object({
    version: z.literal(1).default(1),
    workspace_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes'),
    name: z.string().min(1).max(100),
    ports: z
      .object({
        remote: z.number().int().min(1024).max(65535).default(8787),
        local: z.number().int().min(1024).max(65535).default(8788),
      })
      .strict()
      .default({}),
    limits: z
      .object({
        max_agent_turns: z.number().int().positive().default(8),
        max_review_rounds: z.number().int().positive().default(2),
        max_context_requests: z.number().int().nonnegative().default(4),
        max_response_tokens: z.number().int().min(500).default(4000),
      })
      .strict()
      .default({}),
    context: z
      .object({
        inline_threshold_tokens: z.number().int().positive().default(300),
        file_read_max_lines: z.number().int().positive().default(400),
      })
      .strict()
      .default({}),
    /** Globs (forward slashes, relative to the workspace root) that set a minimum task risk. */
    risk_rules: z
      .object({
        high: z.array(z.string()).optional(),
        low: z.array(z.string()).optional(),
      })
      .strict()
      .default({}),
    /** Extra deny-list globs; the built-in deny-list always applies (SPEC §28.1). */
    deny: z.array(z.string()).default([]),
    /** Outgoing privacy guard for everything sent to ChatGPT (SPEC §28.6). On by default. */
    privacy: z
      .object({
        env_files: z.boolean().default(true),
        pii: z.array(z.enum(['email', 'phone', 'tw_id', 'credit_card'])).default(['email', 'phone', 'tw_id', 'credit_card']),
        /** Added to the built-in allow-list (example.com, example.org, …). */
        allow_email_domains: z.array(z.string()).default([]),
        block_env_threshold: z.number().int().min(1).default(3),
      })
      .strict()
      .default({}),
    runner: z
      .object({
        mode: z.enum(['shadow', 'optimize', 'passthrough']).default('shadow'),
        policy: z.string().default('jest-v1'),
        allow_experimental: z.boolean().default(false),
        timeout_ms: z.number().int().positive().default(600_000),
      })
      .strict()
      .default({}),
  })
  .strict();
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

export const DEFAULT_HIGH_RISK_GLOBS = [
  '**/auth/**',
  '**/authz/**',
  '**/payment*/**',
  '**/migrations/**',
  '**/*secret*',
  '**/.env*',
];
export const DEFAULT_LOW_RISK_GLOBS = ['docs/**', '**/*.md'];
