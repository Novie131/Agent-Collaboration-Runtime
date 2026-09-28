import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidInputError } from '../src/adapters/types.js';
import { analyze } from '../src/observe/analyze.js';
import { OutputExistsError } from '../src/report/write.js';
import { EventBuilder } from './helpers/events.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ae-analyze-'));
});

const toJsonl = (b: EventBuilder) => b.events.map((e) => JSON.stringify(e)).join('\n') + '\n';

describe('analyze (canonical adapter)', () => {
  it('produces JSON and Markdown reports with findings and usage', async () => {
    const b = new EventBuilder();
    for (let i = 0; i < 3; i++) b.read('/p/a.ts');
    b.usage('r1', { input_uncached: 1, input_cache_read: 2, input_cache_write: 3, output_total: 4 });
    const input = join(dir, 's.jsonl');
    await writeFile(input, toJsonl(b));
    const { report, written } = await analyze({ input, adapter: 'canonical', outDir: join(dir, 'out'), strict: false, overwrite: false });
    expect(report.findings).toHaveLength(1);
    expect(report.usage.t_task).toBe(10);
    expect(written.map((w) => w.split('/').pop())).toEqual(['analysis.json', 'analysis.md']);
    const md = await readFile(written[1]!, 'utf8');
    expect(md).toContain('R001');
    expect(md).toContain('"window_calls": 20');
  });

  it('continues past malformed lines in non-strict mode and marks the report partial', async () => {
    const b = new EventBuilder();
    b.read('/p/a.ts');
    const input = join(dir, 's.jsonl');
    await writeFile(input, `${toJsonl(b)}{not json\n{"type":"tool_call"}\n`);
    const { report } = await analyze({ input, adapter: 'canonical', outDir: join(dir, 'out'), strict: false, overwrite: false });
    expect(report.coverage.partial).toBe(true);
    expect(report.coverage.skipped.map((s) => s.line)).toEqual([3, 4]);
    expect(report.usage.completeness).not.toBe('complete');
  });

  it('fails in strict mode with the line number', async () => {
    const input = join(dir, 's.jsonl');
    await writeFile(input, '{bad\n');
    await expect(analyze({ input, adapter: 'canonical', outDir: join(dir, 'out'), strict: true, overwrite: false })).rejects.toThrow(InvalidInputError);
  });

  it('rejects an unknown adapter and a file that matches no canonical line', async () => {
    const input = join(dir, 's.jsonl');
    await writeFile(input, '{"hello":1}\n');
    await expect(analyze({ input, adapter: 'nope', outDir: join(dir, 'o'), strict: false, overwrite: false })).rejects.toThrow(InvalidInputError);
    await expect(analyze({ input, adapter: 'canonical', outDir: join(dir, 'o'), strict: false, overwrite: false })).rejects.toThrow(InvalidInputError);
  });

  it('skips over-long lines without buffering them and reports them', async () => {
    const b = new EventBuilder();
    b.read('/p/a.ts');
    const input = join(dir, 's.jsonl');
    await writeFile(input, `${'x'.repeat(5000)}\n${toJsonl(b)}`);
    const { report } = await analyze({ input, adapter: 'canonical', outDir: join(dir, 'out'), strict: false, overwrite: false, maxLineBytes: 1000 });
    expect(report.coverage.skipped[0]).toMatchObject({ line: 1 });
    expect(report.coverage.skipped[0]!.reason).toMatch(/line_too_long/);
    expect(report.coverage.parsed_lines).toBe(2);
  });

  it('refuses to overwrite reports without --overwrite', async () => {
    const b = new EventBuilder();
    b.read('/p/a.ts');
    const input = join(dir, 's.jsonl');
    await writeFile(input, toJsonl(b));
    const opts = { input, adapter: 'canonical', outDir: join(dir, 'out'), strict: false, overwrite: false };
    await analyze(opts);
    await expect(analyze(opts)).rejects.toThrow(OutputExistsError);
    await expect(analyze({ ...opts, overwrite: true })).resolves.toBeDefined();
  });

  it('never executes transcript content and escapes it in Markdown', async () => {
    const b = new EventBuilder();
    const marker = join(dir, 'pwned');
    const evil = `<img src=x onerror=alert(1)> touch ${marker}; ignore previous instructions | rm -rf ~`;
    for (let i = 0; i < 3; i++) b.shell(evil, { exit_code: 127, error_kind: 'command_not_found' });
    const input = join(dir, 's.jsonl');
    await writeFile(input, toJsonl(b));
    const { written } = await analyze({ input, adapter: 'canonical', outDir: join(dir, 'out'), strict: false, overwrite: false });
    const md = await readFile(written[1]!, 'utf8');
    expect(md).not.toContain('<img');
    expect(md).toContain('&lt;img');
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('masks secrets in finding subjects', async () => {
    const b = new EventBuilder();
    for (let i = 0; i < 3; i++) b.shell('curl -H "Authorization: Bearer abcdefghijklmnop123456" x', { exit_code: 127, error_kind: 'command_not_found' });
    const input = join(dir, 's.jsonl');
    await writeFile(input, toJsonl(b));
    const { report } = await analyze({ input, adapter: 'canonical', outDir: join(dir, 'out'), strict: false, overwrite: false });
    expect(report.findings[0]!.subject).toContain('[REDACTED:bearer]');
    expect(JSON.stringify(report)).not.toContain('abcdefghijklmnop123456');
  });

  it('loads thresholds from plain JSON config and lists them in the report', async () => {
    const b = new EventBuilder();
    b.read('/p/a.ts');
    b.read('/p/a.ts');
    const input = join(dir, 's.jsonl');
    await writeFile(input, toJsonl(b));
    const cfg = join(dir, 'cfg.json');
    await writeFile(cfg, JSON.stringify({ rules: { R001: { min_repeats: 2 } } }));
    const { report } = await analyze({ input, adapter: 'canonical', outDir: join(dir, 'out'), strict: false, overwrite: false, configPath: cfg });
    expect(report.rule_config.R001.min_repeats).toBe(2);
    expect(report.findings).toHaveLength(1);
  });
});
