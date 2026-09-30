import { describe, expect, it } from 'vitest';
import { cumulativeToDeltas, splitInclusiveInput, summarizeUsage } from '@acr/transcripts/usage.js';
import type { UsageEvent } from '@acr/protocol/transcript-events.js';
import { EventBuilder } from './helpers/events.js';

const counts = (u: number, r: number, w: number, o: number) => ({ input_uncached: u, input_cache_read: r, input_cache_write: w, output_total: o });
const usageEvents = (b: EventBuilder) => b.events.filter((e): e is UsageEvent => e.type === 'usage');

describe('T_task accounting', () => {
  it('sums the three mutually exclusive input classes and output once', () => {
    const b = new EventBuilder();
    b.usage('r1', counts(100, 1000, 50, 20));
    b.usage('r2', counts(10, 1100, 0, 5));
    const s = summarizeUsage(usageEvents(b));
    expect(s.completeness).toBe('complete');
    expect(s.t_task).toBe(100 + 1000 + 50 + 20 + 10 + 1100 + 0 + 5);
  });

  it('does not add reasoning a second time', () => {
    const b = new EventBuilder();
    b.usage('r1', counts(10, 0, 0, 300), { reasoning_included_in_output: 250 });
    const s = summarizeUsage(usageEvents(b));
    expect(s.t_task).toBe(310);
    expect(s.reasoning_included_in_output).toBe(250);
  });

  it('counts a sub-agent request seen in both parent and child logs once', () => {
    const b = new EventBuilder();
    b.usage('shared', counts(10, 0, 0, 10));
    b.withStream('child');
    b.usage('shared', counts(10, 0, 0, 10));
    b.usage('child-only', counts(1, 0, 0, 1));
    const s = summarizeUsage(usageEvents(b));
    expect(s.t_task).toBe(22);
    expect(s.duplicate_request_ids).toEqual(['shared']);
  });

  it('marks conflicting duplicates incomplete', () => {
    const b = new EventBuilder();
    b.usage('x', counts(10, 0, 0, 10));
    b.usage('x', counts(11, 0, 0, 10));
    const s = summarizeUsage(usageEvents(b));
    expect(s.completeness).toBe('incomplete');
    expect(s.t_task).toBeNull();
  });

  it('never fills missing fields with zero: incomplete usage gives no T_task', () => {
    const b = new EventBuilder();
    b.usage('r1', counts(10, 0, 0, 10));
    b.usage('r2', null);
    const s = summarizeUsage(usageEvents(b));
    expect(s.completeness).toBe('incomplete');
    expect(s.t_task).toBeNull();
    expect(s.incomplete_requests).toEqual([{ request_id: 'r2', missing_fields: ['output_total'] }]);
  });

  it('no usage at all is not_evaluable, not zero', () => {
    const s = summarizeUsage([]);
    expect(s.completeness).toBe('not_evaluable');
    expect(s.t_task).toBeNull();
  });

  it('known missing requests (e.g. compaction calls) make the total incomplete', () => {
    const b = new EventBuilder();
    b.usage('r1', counts(10, 0, 0, 10));
    const s = summarizeUsage(usageEvents(b), ['compaction call not visible'], true);
    expect(s.completeness).toBe('incomplete');
    expect(s.t_task).toBeNull();
  });
});

describe('cumulative counters', () => {
  it('converts cumulative counters to deltas', () => {
    const { usage, resets } = cumulativeToDeltas([
      { request_id: 'a', counters: counts(10, 0, 0, 5) },
      { request_id: 'b', counters: counts(25, 100, 0, 9) },
    ]);
    expect(resets).toEqual([]);
    expect(usage[1]).toMatchObject(counts(15, 100, 0, 4));
  });

  it('handles a counter reset', () => {
    const { usage, resets } = cumulativeToDeltas([
      { request_id: 'a', counters: counts(100, 0, 0, 50) },
      { request_id: 'b', counters: counts(7, 0, 0, 3) },
    ]);
    expect(resets).toEqual([{ request_id: 'b', fields: ['input_uncached', 'output_total'] }]);
    expect(usage[1]).toMatchObject(counts(7, 0, 0, 3));
  });

  it('keeps missing counters as missing', () => {
    const { usage } = cumulativeToDeltas([{ request_id: 'a', counters: { input_uncached: 1, input_cache_read: 0, input_cache_write: 0 } }]);
    expect(usage[0]).toMatchObject({ completeness: 'incomplete', missing_fields: ['output_total'] });
  });

  it('splits inclusive input and refuses impossible splits', () => {
    expect(splitInclusiveInput(1000, 800, 100)).toBe(100);
    expect(splitInclusiveInput(100, 800, 0)).toBeUndefined();
  });
});
