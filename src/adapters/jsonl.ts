import { createReadStream } from 'node:fs';

export interface JsonlLine {
  line: number;
  value: unknown;
}

export interface JsonlLineError {
  line: number;
  kind: 'invalid_json' | 'line_too_long' | 'invalid_utf8';
  message: string;
}

export interface JsonlReadOptions {
  maxLineBytes: number;
}

export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Streams a JSONL file line by line without loading it whole. Lines longer than
 * `maxLineBytes` are skipped (their bytes are never buffered) and reported.
 */
export async function* readJsonl(
  path: string,
  options: JsonlReadOptions,
): AsyncGenerator<JsonlLine | JsonlLineError> {
  const stream = createReadStream(path);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let chunks: Buffer[] = [];
  let bufferedBytes = 0;
  let overflowing = false;
  let lineNo = 0;

  const finishLine = (): JsonlLine | JsonlLineError | undefined => {
    lineNo += 1;
    if (overflowing) {
      overflowing = false;
      chunks = [];
      bufferedBytes = 0;
      return { line: lineNo, kind: 'line_too_long', message: `line exceeds ${options.maxLineBytes} bytes` };
    }
    const buf = Buffer.concat(chunks, bufferedBytes);
    chunks = [];
    bufferedBytes = 0;
    let text: string;
    try {
      text = decoder.decode(buf);
    } catch {
      return { line: lineNo, kind: 'invalid_utf8', message: 'line is not valid UTF-8' };
    }
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.trim() === '') return undefined;
    try {
      return { line: lineNo, value: JSON.parse(text) as unknown };
    } catch (err) {
      return { line: lineNo, kind: 'invalid_json', message: (err as Error).message };
    }
  };

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      if (!overflowing) {
        const piece = chunk.subarray(start, end);
        if (bufferedBytes + piece.length > options.maxLineBytes) {
          overflowing = true;
          chunks = [];
          bufferedBytes = 0;
        } else if (piece.length > 0) {
          chunks.push(Buffer.from(piece));
          bufferedBytes += piece.length;
        }
      }
      if (nl === -1) break;
      const out = finishLine();
      if (out) yield out;
      start = nl + 1;
    }
  }
  if (bufferedBytes > 0 || overflowing) {
    const out = finishLine();
    if (out) yield out;
  }
}

export function isLineError(x: JsonlLine | JsonlLineError): x is JsonlLineError {
  return 'kind' in x;
}
