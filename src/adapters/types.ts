import type { CanonicalEvent } from '../schema/events.js';

export type AdapterStatus = 'supported' | 'experimental' | 'unsupported';

export interface AdapterInfo {
  id: string;
  host: string;
  status: AdapterStatus;
  /** Host versions actually exercised against real (de-identified) samples. Empty = none. */
  tested_versions: string[];
  fixtures: string[];
  observable: {
    tools: string;
    subagents: string;
    compaction: string;
  };
  usage_semantics: string;
  cache_semantics: string;
  reasoning_semantics: string;
  limitations: string[];
}

export interface SkippedLine {
  line: number;
  reason: string;
}

export interface Coverage {
  input_id: string;
  total_lines: number;
  parsed_lines: number;
  ignored_lines: number;
  skipped: SkippedLine[];
  partial: boolean;
}

export interface ParseOptions {
  strict: boolean;
  maxLineBytes: number;
  inputId: string;
}

export interface ParseResult {
  events: CanonicalEvent[];
  coverage: Coverage;
  warnings: string[];
  /** Model calls known to exist but absent from the input; any entry makes T_task incomplete. */
  unobservedRequests?: string[];
}

export interface Adapter {
  info: AdapterInfo;
  parse(path: string, options: ParseOptions): Promise<ParseResult>;
}

/** Input is structurally unusable in strict mode, or the format is not recognised. */
export class InvalidInputError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = 'InvalidInputError';
  }
}
