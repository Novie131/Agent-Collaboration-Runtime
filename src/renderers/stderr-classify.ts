import { relative, sep } from 'node:path';
import { isPendingLike, type JestAssertion, type ParsedJestResult } from './jest-result.js';

/**
 * Splits Jest's default-reporter stderr into
 *   - segments proven to duplicate information rendered in the view, and
 *   - everything else, kept verbatim and in order.
 * No generic "looks unimportant" filtering: a line is only dropped when it is a
 * known reporter line whose content is verified against the JSON result.
 */

export type LineClass =
  | 'failure_message_duplicate'
  | 'suite_header'
  | 'summary_verified'
  | 'ran_all'
  | 'results_written'
  | 'verbose_test_line'
  | 'verbose_describe_line'
  | 'blank'
  | 'retained';

export interface ClassifiedLine {
  text: string;
  cls: LineClass;
  suite?: string;
}

export interface StderrClassification {
  lines: ClassifiedLine[];
  counts: Record<LineClass, number>;
  /** Retained text with suite headers re-inserted as context where retained lines follow them. */
  retainedText: string;
  retainedLineCount: number;
  duplicateFailureBlocks: number;
}

const HEADER_RE = /^(PASS|FAIL) (.+?)(?: \(\d+(?:\.\d+)? ?m?s\))?(?: \(\d+ MB heap size\))?\s*$/;
// Titles may contain leading/trailing spaces, so only the "(N ms)" suffix is stripped.
const VERBOSE_RE = /^(\s+)(✓|✕|○|✎|√|×) (.*?)(?: \(\d+(?:\.\d+)? ?m?s\))?$/;
const TIME_RE = /^Time:\s+\d+(?:\.\d+)? ?m?s(?:, estimated \d+(?:\.\d+)? ?m?s)?\s*$/;
const RAN_ALL_RE = /^Ran all test suites(?: matching .+| related to .+| within paths .+)?\.\s*$/;

const SYMBOL_STATUS: Record<string, (s: JestAssertion['status']) => boolean> = {
  '✓': (s) => s === 'passed',
  '√': (s) => s === 'passed',
  '✕': (s) => s === 'failed',
  '×': (s) => s === 'failed',
  '○': (s) => isPendingLike(s),
  '✎': (s) => s === 'todo',
};

function parsePairs(body: string): Map<string, number> | undefined {
  const parts = body.split(',').map((p) => p.trim());
  const m = new Map<string, number>();
  for (const p of parts) {
    const hit = /^(\d+) ([a-z]+)$/.exec(p);
    if (!hit) return undefined;
    m.set(hit[2]!, Number(hit[1]));
  }
  return m;
}

function verifySummary(line: string, r: ParsedJestResult): boolean {
  const a = r.aggregated;
  const check = (body: string, expected: Record<string, number>) => {
    const pairs = parsePairs(body);
    if (!pairs || !pairs.has('total')) return false;
    for (const [k, v] of pairs) if (expected[k] === undefined || expected[k] !== v) return false;
    return true;
  };
  let m = /^Test Suites:\s+(.+?)\s*$/.exec(line);
  if (m) return check(m[1]!, { failed: a.numFailedTestSuites, skipped: a.numPendingTestSuites, passed: a.numPassedTestSuites, total: a.numTotalTestSuites });
  m = /^Tests:\s+(.+?)\s*$/.exec(line);
  if (m) return check(m[1]!, { failed: a.numFailedTests, skipped: a.numPendingTests, todo: a.numTodoTests, passed: a.numPassedTests, total: a.numTotalTests });
  m = /^Snapshots:\s+(.+?)\s*$/.exec(line);
  if (m) {
    const s = a.snapshot;
    return check(m[1]!, { failed: s.unmatched, passed: s.matched, written: s.added, updated: s.updated, total: s.total });
  }
  return false;
}

export function classifyStderr(stderr: string, r: ParsedJestResult, rootDir: string, jsonOutputPath: string): StderrClassification {
  // 1. Remove exact occurrences of each failed suite's formatted message (rendered verbatim in the view).
  const ranges: [number, number][] = [];
  let duplicateFailureBlocks = 0;
  for (const s of r.suites) {
    if (s.status !== 'failed' || s.message.trim() === '') continue;
    let from = 0;
    for (;;) {
      const at = stderr.indexOf(s.message, from);
      if (at === -1) break;
      if (!ranges.some(([a, b]) => at < b && at + s.message.length > a)) {
        ranges.push([at, at + s.message.length]);
        duplicateFailureBlocks++;
      }
      from = at + s.message.length;
    }
  }
  ranges.sort((x, y) => x[0] - y[0]);

  const lines: ClassifiedLine[] = [];
  const pushText = (text: string) => {
    const parts = text.split('\n');
    for (const p of parts) lines.push({ text: p, cls: 'retained' });
  };
  let pos = 0;
  for (const [a, b] of ranges) {
    pushText(stderr.slice(pos, a));
    lines.push({ text: stderr.slice(a, b), cls: 'failure_message_duplicate' });
    pos = b;
  }
  pushText(stderr.slice(pos));

  // 2. Line-level classification of what remains.
  const suitesByRel = new Map<string, ParsedJestResult['suites'][number]>();
  for (const s of r.suites) suitesByRel.set(relative(rootDir, s.name).split(sep).join('/'), s);
  const writtenRel = relative(rootDir, jsonOutputPath);
  let currentSuite: ParsedJestResult['suites'][number] | undefined;

  for (const l of lines) {
    if (l.cls !== 'retained') continue;
    const text = l.text.replace(/\r$/, '');
    if (text.trim() === '') {
      l.cls = 'blank';
      continue;
    }
    const h = HEADER_RE.exec(text);
    if (h) {
      const rest = h[2]!;
      const hit = [...suitesByRel.entries()].find(([rel]) => rest === rel || rest.endsWith(` ${rel}`));
      const statusOk = hit && (h[1] === 'FAIL' ? hit[1].status === 'failed' : hit[1].status !== 'failed');
      if (hit && statusOk) {
        l.cls = 'suite_header';
        l.suite = hit[0];
        currentSuite = hit[1];
        continue;
      }
    }
    if (verifySummary(text, r)) {
      l.cls = 'summary_verified';
      continue;
    }
    // Jest's SummaryReporter heading before it re-prints failures (> 20 suites); those blocks are removed as duplicates above.
    const failingSummaryHeading = text === 'Summary of all failing tests' && r.suites.some((s) => s.status === 'failed');
    if (TIME_RE.test(text) || RAN_ALL_RE.test(text) || failingSummaryHeading) {
      l.cls = 'ran_all';
      continue;
    }
    if (text === `Test results written to: ${writtenRel}` || text === `Test results written to: ${jsonOutputPath}`) {
      l.cls = 'results_written';
      continue;
    }
    const v = VERBOSE_RE.exec(text);
    if (v && currentSuite) {
      const symbol = v[2]!;
      // Jest 29 verbose prints "○ skipped <title>" and "✎ todo <title>" (seen in fixtures/real).
      const prefix = symbol === '○' ? 'skipped ' : symbol === '✎' ? 'todo ' : '';
      const titles = [v[3]!, ...(prefix && v[3]!.startsWith(prefix) ? [v[3]!.slice(prefix.length)] : [])];
      const ok = SYMBOL_STATUS[symbol];
      if (ok && currentSuite.assertions.some((x) => titles.includes(x.title) && ok(x.status))) {
        l.cls = 'verbose_test_line';
        continue;
      }
    }
  }

  // 3. Describe-block titles, only inside a contiguous run that contains verbose test lines.
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && (lines[j]!.cls === 'verbose_test_line' || lines[j]!.cls === 'retained')) j++;
    const run = lines.slice(i, j);
    if (run.some((l) => l.cls === 'verbose_test_line')) {
      const titles = new Set(r.suites.flatMap((s) => s.assertions.flatMap((a) => a.ancestorTitles)));
      if (run.every((l) => l.cls === 'verbose_test_line' || (/^\s+\S/.test(l.text) && titles.has(l.text.trim())))) {
        for (const l of run) if (l.cls === 'retained') l.cls = 'verbose_describe_line';
      }
    }
    i = j === i ? i + 1 : j;
  }

  // 4. Render retained text: keep blank lines only between retained lines of one contiguous region,
  //    and re-insert the suite header before retained content that follows it.
  const counts = Object.fromEntries(
    (['failure_message_duplicate', 'suite_header', 'summary_verified', 'ran_all', 'results_written', 'verbose_test_line', 'verbose_describe_line', 'blank', 'retained'] as LineClass[]).map((c) => [c, 0]),
  ) as Record<LineClass, number>;
  for (const l of lines) counts[l.cls]++;

  const out: string[] = [];
  let pendingHeader: string | undefined;
  let pendingBlanks: string[] = [];
  let inRegion = false;
  let retainedLineCount = 0;
  for (const l of lines) {
    if (l.cls === 'suite_header') {
      pendingHeader = l.text;
      inRegion = false;
      pendingBlanks = [];
      continue;
    }
    if (l.cls === 'blank') {
      if (inRegion) pendingBlanks.push(l.text);
      continue;
    }
    if (l.cls !== 'retained') {
      inRegion = false;
      pendingBlanks = [];
      if (l.cls === 'summary_verified' || l.cls === 'ran_all' || l.cls === 'results_written') pendingHeader = undefined;
      continue;
    }
    if (pendingHeader !== undefined) {
      out.push(`${pendingHeader}   [suite header, shown for context]`);
      pendingHeader = undefined;
    }
    out.push(...pendingBlanks);
    pendingBlanks = [];
    out.push(l.text);
    retainedLineCount++;
    inRegion = true;
  }
  return { lines, counts, retainedText: out.join('\n'), retainedLineCount, duplicateFailureBlocks };
}
