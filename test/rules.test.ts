import { describe, expect, it } from 'vitest';
import { DEFAULT_RULE_CONFIG, runRules } from '../src/observe/rules.js';
import { EventBuilder } from './helpers/events.js';

const rules = (b: EventBuilder) => runRules(b.events, DEFAULT_RULE_CONFIG);

describe('R001 repeated read', () => {
  it('flags three identical reads within the window (positive)', () => {
    const b = new EventBuilder();
    b.read('/p/a.ts');
    b.read('/p/a.ts');
    b.read('/p/a.ts');
    const out = rules(b);
    const f = out.findings.filter((x) => x.rule === 'R001');
    expect(f).toHaveLength(1);
    expect(f[0]!.occurrences).toBe(3);
    expect(f[0]!.event_ids).toHaveLength(6);
    expect(f[0]!.source_refs.length).toBeGreaterThan(0);
    expect(f[0]!.limitations.length).toBeGreaterThan(0);
  });

  it('does not flag two reads, or reads with different content hash (negative)', () => {
    const b = new EventBuilder();
    b.read('/p/a.ts', 'h1');
    b.read('/p/a.ts', 'h1');
    b.read('/p/a.ts', 'h2');
    expect(rules(b).findings).toHaveLength(0);
  });

  it('resets after a known file change to the same path', () => {
    const b = new EventBuilder();
    b.read('/p/a.ts');
    b.read('/p/a.ts');
    b.fileChange('/p/a.ts');
    b.read('/p/a.ts');
    expect(rules(b).findings).toHaveLength(0);
  });

  it('resets after a new user requirement', () => {
    const b = new EventBuilder();
    b.read('/p/a.ts');
    b.read('/p/a.ts');
    b.user();
    b.read('/p/a.ts');
    expect(rules(b).findings).toHaveLength(0);
  });

  it('treats a compaction (new context epoch) as a separate group', () => {
    const b = new EventBuilder();
    b.read('/p/a.ts');
    b.read('/p/a.ts');
    b.withEpoch('e1');
    b.read('/p/a.ts');
    expect(rules(b).findings).toHaveLength(0);
  });

  it('does not merge different sub-agent streams', () => {
    const b = new EventBuilder();
    b.read('/p/a.ts');
    b.withStream('sub');
    b.read('/p/a.ts');
    b.withStream('main');
    b.read('/p/a.ts');
    expect(rules(b).findings).toHaveLength(0);
  });

  it('respects the 20-call window', () => {
    const b = new EventBuilder();
    b.read('/p/a.ts');
    b.read('/p/a.ts');
    for (let i = 0; i < 20; i++) b.other();
    b.read('/p/a.ts');
    expect(rules(b).findings).toHaveLength(0);
  });

  it('reports reads without content hash as not evaluable instead of guessing (unknown data)', () => {
    const b = new EventBuilder();
    b.read('/p/a.ts', null);
    b.read('/p/a.ts', null);
    b.read('/p/a.ts', null);
    const out = rules(b);
    expect(out.findings).toHaveLength(0);
    expect(out.not_evaluable).toEqual([{ rule: 'R001', reason: 'read result without content_hash', count: 3 }]);
  });

  it('distinguishes ranges and notes partial-hash limitation', () => {
    const b = new EventBuilder();
    for (let i = 0; i < 3; i++) b.read('/p/a.ts', 'h', { start: 1, end: 50 });
    b.read('/p/a.ts', 'h', { start: 51, end: 100 });
    const f = rules(b).findings;
    expect(f).toHaveLength(1);
    expect(f[0]!.occurrences).toBe(3);
    expect(f[0]!.limitations.join(' ')).toMatch(/only the read range/);
  });
});

describe('R002 repeated search', () => {
  it('flags three identical searches (positive)', () => {
    const b = new EventBuilder();
    for (let i = 0; i < 3; i++) b.search('fooBar');
    const f = rules(b).findings;
    expect(f.map((x) => x.rule)).toEqual(['R002']);
    expect(f[0]!.confidence).toBe('high');
  });

  it('does not flag narrowed scope or changed flags (negative)', () => {
    const b = new EventBuilder();
    b.search('fooBar', 'src');
    b.search('fooBar', 'src/lib');
    b.search('fooBar', 'src', 'sh1', { '-i': true });
    expect(rules(b).findings).toHaveLength(0);
  });

  it('lowers confidence when result hashes differ (unknown data)', () => {
    const b = new EventBuilder();
    b.search('x', 'src', 'a');
    b.search('x', 'src', 'b');
    b.search('x', 'src', 'c');
    expect(rules(b).findings[0]!.confidence).toBe('low');
  });

  it('reports a search without a query as not evaluable', () => {
    const b = new EventBuilder();
    b.tool('search', 'Grep', { args: {} }, {});
    expect(rules(b).not_evaluable[0]).toMatchObject({ rule: 'R002' });
  });
});

describe('R003 environment-failure retry', () => {
  const notFound = { exit_code: 127, error_kind: 'command_not_found' };

  it('flags the same command failing with command_not_found three times (positive)', () => {
    const b = new EventBuilder();
    for (let i = 0; i < 3; i++) b.shell('pnpm test', notFound);
    const f = rules(b).findings;
    expect(f.map((x) => x.rule)).toEqual(['R003']);
    expect(f[0]!.occurrences).toBe(3);
  });

  it('splits after an install / unknown environment operation (negative)', () => {
    const b = new EventBuilder();
    b.shell('pnpm test', notFound);
    b.shell('pnpm test', notFound);
    b.shell('npm i -g pnpm', { exit_code: 0 });
    b.shell('pnpm test', notFound);
    expect(rules(b).findings).toHaveLength(0);
  });

  it('does not count network errors or flaky tests (negative)', () => {
    const b = new EventBuilder();
    for (let i = 0; i < 4; i++) b.shell('npm ci', { exit_code: 1, error_kind: 'network' });
    for (let i = 0; i < 4; i++) b.shell('npm test', { exit_code: 1, error_kind: 'flaky_test' });
    expect(rules(b).findings).toHaveLength(0);
  });

  it('does not reset on intervening reads (reads cannot fix the environment)', () => {
    const b = new EventBuilder();
    b.shell('tsc', notFound);
    b.read('/p/x.ts');
    b.shell('tsc', notFound);
    b.shell('tsc', notFound);
    expect(rules(b).findings.map((x) => x.rule)).toEqual(['R003']);
  });

  it('reports a shell call without result as not evaluable (unknown data)', () => {
    const b = new EventBuilder();
    b.tool('shell', 'Bash', { args: { command: 'x' } });
    b.events = b.events.filter((e) => e.type !== 'tool_result');
    expect(rules(b).not_evaluable.some((n) => n.rule === 'R003')).toBe(true);
  });
});

describe('R004 expansion after compressed output', () => {
  it('flags an expansion within 10 calls, with causality unproven (positive)', () => {
    const b = new EventBuilder();
    b.tool('shell', 'agent-efficiency test', { args: { command: 'agent-efficiency test' } }, { artifact_id: 'ae_1', policy_id: 'jest-v1' });
    b.other();
    b.tool('shell', 'agent-efficiency expand', { args: { command: 'expand' }, expanded_from_artifact_id: 'ae_1' });
    const f = rules(b).findings;
    expect(f.map((x) => x.rule)).toEqual(['R004']);
    expect(f[0]!.causality).toBe('unproven');
  });

  it('does not flag an expansion outside the window, or without linkage (negative)', () => {
    const b = new EventBuilder();
    b.tool('shell', 't', { args: { command: 't' } }, { artifact_id: 'ae_1' });
    for (let i = 0; i < 11; i++) b.other();
    b.tool('shell', 'e', { args: { command: 'e' }, expanded_from_artifact_id: 'ae_1' });
    b.tool('shell', 'e2', { args: { command: 'expand something' } });
    expect(rules(b).findings).toHaveLength(0);
  });

  it('marks expansion of an unknown artifact as not evaluable', () => {
    const b = new EventBuilder();
    b.tool('shell', 'e', { args: { command: 'e' }, expanded_from_artifact_id: 'ae_x' });
    expect(rules(b).not_evaluable[0]).toMatchObject({ rule: 'R004' });
  });
});

describe('configurable thresholds', () => {
  it('uses the given thresholds', () => {
    const b = new EventBuilder();
    b.read('/p/a.ts');
    b.read('/p/a.ts');
    const out = runRules(b.events, { ...DEFAULT_RULE_CONFIG, R001: { window_calls: 20, min_repeats: 2 } });
    expect(out.findings).toHaveLength(1);
  });
});
