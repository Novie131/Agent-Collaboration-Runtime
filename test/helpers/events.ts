import type { CanonicalEvent, ToolCategory } from '@acr/protocol/transcript-events.js';

/** Builds canonical event sequences for rule tests (synthetic). */
export class EventBuilder {
  events: CanonicalEvent[] = [];
  private seq = 0;
  private call = 0;

  constructor(
    private stream = 'main',
    private epoch = 'e0',
    private session = 's1',
  ) {}

  private base(id: string) {
    this.seq += 1;
    return {
      schema_version: 2 as const,
      id,
      task_id: 't1',
      run_id: 'r1',
      session_id: this.session,
      stream_id: this.stream,
      context_epoch: this.epoch,
      sequence: this.seq,
      source_ref: { input_id: 'synthetic', line: this.seq },
    };
  }

  withStream(stream: string) {
    this.stream = stream;
    return this;
  }

  withEpoch(epoch: string) {
    this.epoch = epoch;
    return this;
  }

  tool(category: ToolCategory, name: string, callExtra: Record<string, unknown>, resultExtra: Record<string, unknown> = {}) {
    const id = `c${++this.call}`;
    this.events.push({ ...this.base(`${id}:call`), type: 'tool_call', tool_call_id: id, category, tool_name: name, ...callExtra } as CanonicalEvent);
    this.events.push({ ...this.base(`${id}:result`), type: 'tool_result', tool_call_id: id, category, tool_name: name, ...resultExtra } as CanonicalEvent);
    return id;
  }

  /** Pass hash = null for a read result without a content hash. */
  read(path: string, hash: string | null = 'h1', range?: { start: number; end: number }) {
    return this.tool('read', 'Read', { path, ...(range ? { range } : {}) }, hash ? { content_hash: hash } : {});
  }

  search(query: string, scope = 'src', hash = 'sh1', flags: Record<string, unknown> = {}) {
    return this.tool('search', 'Grep', { args: { query, scope, flags } }, { content_hash: hash });
  }

  shell(command: string, result: Record<string, unknown>) {
    return this.tool('shell', 'Bash', { args: { command } }, result);
  }

  other(name = 'Other') {
    return this.tool('other', name, {});
  }

  fileChange(path: string) {
    this.events.push({ ...this.base(`fc${this.seq + 1}`), type: 'file_change', path } as CanonicalEvent);
    return this;
  }

  user(newRequirement?: boolean) {
    this.events.push({ ...this.base(`u${this.seq + 1}`), type: 'user_message', ...(newRequirement === undefined ? {} : { new_requirement: newRequirement }) } as CanonicalEvent);
    return this;
  }

  usage(requestId: string, counts: Record<string, number> | null, extra: Record<string, unknown> = {}) {
    const usage = counts
      ? { request_id: requestId, ...counts, scope: 'request', origin: 'provider_reported', ...extra }
      : { request_id: requestId, scope: 'request', origin: 'provider_reported', completeness: 'incomplete', missing_fields: ['output_total'], ...extra };
    this.events.push({ ...this.base(`usage:${requestId}:${this.seq + 1}`), type: 'usage', usage } as CanonicalEvent);
    return this;
  }
}
