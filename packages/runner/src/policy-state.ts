import { z } from 'zod';

export type PolicyStatus = 'experimental' | 'validated_for_scope' | 'disabled';

/** Everything a validation is bound to. Any change sends the policy back to experimental. */
export const ValidationScope = z
  .object({
    policy_hash: z.string(),
    renderer_version: z.string(),
    host: z.object({ name: z.string(), version: z.string() }).strict(),
    model: z.object({ id: z.string(), reasoning_effort: z.string() }).strict(),
    task_set_digest: z.string(),
  })
  .strict();
export type ValidationScope = z.infer<typeof ValidationScope>;

export const ValidationRecord = z
  .object({
    policy_id: z.string(),
    status: z.literal('validated_for_scope'),
    scope: ValidationScope,
    evaluation_digest: z.string(),
    validated_at: z.string(),
  })
  .strict();
export type ValidationRecord = z.infer<typeof ValidationRecord>;

const ALLOWED: Record<PolicyStatus, PolicyStatus[]> = {
  experimental: ['validated_for_scope', 'disabled'],
  validated_for_scope: ['disabled', 'experimental'],
  disabled: [],
};

export function canTransition(from: PolicyStatus, to: PolicyStatus): boolean {
  return ALLOWED[from].includes(to);
}

function scopeDiff(a: ValidationScope, b: ValidationScope): string[] {
  const diffs: string[] = [];
  if (a.policy_hash !== b.policy_hash) diffs.push('policy_hash');
  if (a.renderer_version !== b.renderer_version) diffs.push('renderer_version');
  if (a.host.name !== b.host.name || a.host.version !== b.host.version) diffs.push('host');
  if (a.model.id !== b.model.id || a.model.reasoning_effort !== b.model.reasoning_effort) diffs.push('model');
  if (a.task_set_digest !== b.task_set_digest) diffs.push('task_set_digest');
  return diffs;
}

/**
 * Effective status for a policy. A validation record only counts when its
 * whole scope matches the current one; otherwise the policy is experimental.
 */
export function effectiveStatus(args: {
  policyId: string;
  disabled: boolean;
  record?: ValidationRecord;
  current?: ValidationScope;
}): { status: PolicyStatus; reason: string } {
  if (args.disabled) return { status: 'disabled', reason: 'disabled by configuration' };
  if (!args.record) return { status: 'experimental', reason: 'no validation record' };
  if (args.record.policy_id !== args.policyId) return { status: 'experimental', reason: 'validation record is for another policy' };
  if (!args.current) return { status: 'experimental', reason: 'current scope unknown; validation cannot be applied' };
  const diffs = scopeDiff(args.record.scope, args.current);
  if (diffs.length) return { status: 'experimental', reason: `scope changed: ${diffs.join(', ')}` };
  return { status: 'validated_for_scope', reason: 'validation record matches the current scope' };
}
