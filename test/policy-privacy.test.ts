import { describe, expect, it } from 'vitest';
import { checkJestArgs } from '@acr/runner/jest-args.js';
import { JEST_V1, policyHash } from '@acr/runner/policy-registry.js';
import { canTransition, effectiveStatus, type ValidationRecord, type ValidationScope } from '@acr/runner/policy-state.js';
import { displayPath, mdCodeBlock, mdInline, redact } from '@acr/security/redact.js';

const scope: ValidationScope = {
  policy_hash: policyHash(JEST_V1),
  renderer_version: JEST_V1.renderer_version,
  host: { name: 'claude-code', version: '2.0.0' },
  model: { id: 'm', reasoning_effort: 'high' },
  task_set_digest: 'sha256:t',
};
const record: ValidationRecord = { policy_id: 'jest-v1', status: 'validated_for_scope', scope, evaluation_digest: 'sha256:e', validated_at: '2026-09-01' };

describe('policy status', () => {
  it('defaults to experimental without a validation record', () => {
    expect(effectiveStatus({ policyId: 'jest-v1', disabled: false }).status).toBe('experimental');
  });

  it('is validated only when the full scope matches', () => {
    expect(effectiveStatus({ policyId: 'jest-v1', disabled: false, record, current: scope }).status).toBe('validated_for_scope');
  });

  it.each([
    ['policy hash', { policy_hash: 'sha256:other' }],
    ['renderer', { renderer_version: '9' }],
    ['host version', { host: { name: 'claude-code', version: '2.1.0' } }],
    ['model effort', { model: { id: 'm', reasoning_effort: 'low' } }],
    ['task set', { task_set_digest: 'sha256:x' }],
  ])('drops back to experimental when %s changes', (_n, change) => {
    const r = effectiveStatus({ policyId: 'jest-v1', disabled: false, record, current: { ...scope, ...change } as ValidationScope });
    expect(r.status).toBe('experimental');
    expect(r.reason).toMatch(/scope changed/);
  });

  it('only allows the specified transitions', () => {
    expect(canTransition('experimental', 'validated_for_scope')).toBe(true);
    expect(canTransition('experimental', 'disabled')).toBe(true);
    expect(canTransition('validated_for_scope', 'disabled')).toBe(true);
    expect(canTransition('validated_for_scope', 'experimental')).toBe(true);
    expect(canTransition('disabled', 'validated_for_scope')).toBe(false);
  });

  it('policy hash changes when the definition changes', () => {
    expect(policyHash({ ...JEST_V1, omits: [] })).not.toBe(policyHash(JEST_V1));
  });
});

describe('Jest argument policy', () => {
  it('lists denied flags with reasons and accepts everything else', () => {
    expect(checkJestArgs(['--watchAll']).denied[0]!.reason).toMatch(/watch/);
    expect(checkJestArgs(['--outputFile', 'x']).ok).toBe(false);
    expect(checkJestArgs(['--no-json']).ok).toBe(false);
    expect(checkJestArgs(['-t', 'name', '--runInBand', 'src/a.test.js', '--ci', '--no-watchAll']).ok).toBe(true);
  });
});

describe('privacy helpers', () => {
  it('masks common secret shapes but says nothing about completeness', () => {
    const { text, redactions } = redact(
      'AKIAABCDEFGHIJKLMNOP ghp_abcdefghijklmnopqrstuvwxyz0123 sk-ant-abcdefghijklmnopqrst DB_PASSWORD=hunter2hunter https://u:p4ss@host/x',
    );
    expect(text).not.toMatch(/AKIAABCDEFGHIJKLMNOP|ghp_abc|sk-ant-abc|hunter2|p4ss/);
    expect(Object.keys(redactions).length).toBeGreaterThanOrEqual(4);
  });

  it('escapes Markdown/HTML and fences code safely', () => {
    expect(mdInline('<script>x</script> ![img](http://e/x.png) | a')).not.toMatch(/<script|!\[img\]\(/);
    const block = mdCodeBlock('```\nnested\n```');
    expect(block.startsWith('````')).toBe(true);
  });

  it('shows paths relative to the root', () => {
    expect(displayPath('/a/b/c.ts', '/a')).toBe('b/c.ts');
    expect(displayPath('/elsewhere/x', '/a')).toBe('/elsewhere/x');
  });
});
