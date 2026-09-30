import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef, ArtifactType } from '@acr/protocol/collaboration.js';
import { estimateTokens } from '@acr/platform/tokens.js';
import { redactText } from '@acr/security/redact.js';
import type { ArtifactRow, HubStore } from '@acr/storage/hub-store.js';

export type LineRange = { start: number; end: number };
export type ArtifactSlice = {
  artifact: ArtifactRef;
  range: LineRange;
  total_lines: number;
  text: string;
  redacted: boolean;
};

const countLines = (s: string) => (s.length === 0 ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0));

/**
 * Hub artifact store (SPEC §20.1): content is written once under the project data directory,
 * hashed, and served by line range. Reads are redacted unless the caller is allowed raw access.
 */
export class HubArtifacts {
  constructor(
    private readonly store: HubStore,
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  put(taskId: string | null, type: ArtifactType, content: string, meta: Record<string, unknown> = {}): ArtifactRef {
    const id = this.store.nextId('artifact', 'ART');
    const file = `${id}.txt`;
    writeFileSync(join(this.dir, file), content, { flag: 'wx', mode: 0o600 });
    const row: ArtifactRow = {
      id,
      task_id: taskId,
      type,
      ref: `runtime://artifacts/${id}`,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
      lines: countLines(content),
      estimated_tokens: estimateTokens(content),
      file,
      created_at: this.now().toISOString(),
      meta,
    };
    this.store.insertArtifact(row);
    return toRef(row);
  }

  get(id: string): ArtifactRef | undefined {
    const row = this.store.getArtifact(id);
    return row ? toRef(row) : undefined;
  }

  row(id: string): ArtifactRow | undefined {
    return this.store.getArtifact(id);
  }

  /** Reads lines [start, end] (1-based, inclusive). Verifies the stored hash before returning anything. */
  read(id: string, range?: Partial<LineRange>, opts: { raw?: boolean } = {}): ArtifactSlice | undefined {
    const row = this.store.getArtifact(id);
    if (!row) return undefined;
    const content = readFileSync(join(this.dir, row.file), 'utf8');
    if (createHash('sha256').update(content).digest('hex') !== row.sha256) {
      throw new Error(`artifact ${id} failed its integrity check (content changed on disk)`);
    }
    const lines = content.split('\n');
    if (content.endsWith('\n')) lines.pop();
    const start = Math.max(1, range?.start ?? 1);
    const end = Math.min(lines.length, range?.end ?? lines.length);
    const slice = start > end ? '' : lines.slice(start - 1, end).join('\n');
    const text = opts.raw ? slice : redactText(slice);
    return { artifact: toRef(row), range: { start, end }, total_lines: lines.length, text, redacted: text !== slice };
  }
}

const toRef = (row: ArtifactRow): ArtifactRef => ({
  id: row.id,
  type: row.type,
  ref: row.ref,
  lines: row.lines,
  bytes: row.bytes,
  estimated_tokens: row.estimated_tokens,
  sha256: row.sha256,
});
