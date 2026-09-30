import type {
  Actor,
  ArtifactRef,
  ArtifactType,
  ContextRequest,
  Decision,
  Review,
  Task,
  TaskResult,
  TaskState,
} from '@acr/protocol/collaboration.js';
import type { RuntimeEvent, RuntimeEventType, ToolCallRecord } from '@acr/protocol/runtime-events.js';
import type { SqlDatabase } from './sql.js';

/** Schema migrations, applied in order; `PRAGMA user_version` records how many ran. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE results (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), round INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX results_task ON results(task_id, round);
  CREATE TABLE reviews (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), round INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX reviews_task ON reviews(task_id, round);
  CREATE TABLE decisions (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, status TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL);
  CREATE TABLE context_requests (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, task_id TEXT, type TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
    lines INTEGER NOT NULL, estimated_tokens INTEGER NOT NULL, file TEXT NOT NULL, created_at TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE runtime_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, type TEXT NOT NULL, actor TEXT NOT NULL,
    timestamp TEXT NOT NULL, payload TEXT NOT NULL
  );
  CREATE INDEX runtime_events_task ON runtime_events(task_id, id);
  CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, endpoint TEXT NOT NULL, tool TEXT NOT NULL,
    task_id TEXT, request_tokens INTEGER NOT NULL, response_tokens INTEGER NOT NULL, ok INTEGER NOT NULL,
    estimator TEXT NOT NULL
  );
  CREATE INDEX tool_calls_task ON tool_calls(task_id, id);
  CREATE TABLE agent_sessions (
    session_id TEXT NOT NULL, task_id TEXT NOT NULL, transcript_path TEXT NOT NULL, tool TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
  CREATE INDEX agent_sessions_task ON agent_sessions(task_id);
  `,
];

export function migrate(db: SqlDatabase): void {
  const current = Number(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema version ${current} is newer than this acr build supports (${MIGRATIONS.length})`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(s: unknown) => JSON.parse(String(s)) as T;

export type ArtifactRow = ArtifactRef & { task_id: string | null; file: string; created_at: string; meta: Record<string, unknown> };
export type SessionRow = { session_id: string; task_id: string; transcript_path: string; tool: string; timestamp: string };

/** Repository over the hub database. Plain data in, plain data out; no business rules. */
export class HubStore {
  constructor(readonly db: SqlDatabase) {
    migrate(db);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  nextId(counter: string, prefix: string): string {
    const row = this.db.get<{ value: number }>(
      `INSERT INTO counters(name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`,
      counter,
    );
    return `${prefix}-${row!.value}`;
  }

  // ------------------------------------------------------------ tasks
  insertTask(task: Task): void {
    const seq = Number(task.id.split('-').pop());
    this.db.run(
      'INSERT INTO tasks(id, seq, state, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      task.id, seq, task.state, json(task), task.created_at, task.updated_at,
    );
  }
  updateTask(task: Task): void {
    this.db.run('UPDATE tasks SET state = ?, data = ?, updated_at = ? WHERE id = ?', task.state, json(task), task.updated_at, task.id);
  }
  getTask(id: string): Task | undefined {
    const r = this.db.get('SELECT data FROM tasks WHERE id = ?', id);
    return r ? parse<Task>(r.data) : undefined;
  }
  listTasks(states?: TaskState[]): Task[] {
    const rows = states?.length
      ? this.db.all(`SELECT data FROM tasks WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY seq`, ...states)
      : this.db.all('SELECT data FROM tasks ORDER BY seq');
    return rows.map((r) => parse<Task>(r.data));
  }

  // ------------------------------------------------------------ results
  insertResult(r: TaskResult): void {
    this.db.run('INSERT INTO results(id, task_id, round, data) VALUES (?, ?, ?, ?)', r.id, r.task_id, r.round, json(r));
  }
  latestResult(taskId: string): TaskResult | undefined {
    const r = this.db.get('SELECT data FROM results WHERE task_id = ? ORDER BY round DESC LIMIT 1', taskId);
    return r ? parse<TaskResult>(r.data) : undefined;
  }
  countResults(taskId: string): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM results WHERE task_id = ?', taskId)!.n);
  }

  // ------------------------------------------------------------ reviews
  insertReview(r: Review): void {
    this.db.run('INSERT INTO reviews(id, task_id, round, data) VALUES (?, ?, ?, ?)', r.id, r.task_id, r.round, json(r));
  }
  updateReview(r: Review): void {
    this.db.run('UPDATE reviews SET data = ? WHERE id = ?', json(r), r.id);
  }
  getReview(id: string): Review | undefined {
    const r = this.db.get('SELECT data FROM reviews WHERE id = ?', id);
    return r ? parse<Review>(r.data) : undefined;
  }
  listReviews(taskId: string): Review[] {
    return this.db.all('SELECT data FROM reviews WHERE task_id = ? ORDER BY round, id', taskId).map((r) => parse<Review>(r.data));
  }

  // ------------------------------------------------------------ decisions
  insertDecision(d: Decision): void {
    const seq = Number(d.id.split('-').pop());
    this.db.run('INSERT INTO decisions(id, seq, status, task_id, data) VALUES (?, ?, ?, ?, ?)', d.id, seq, d.status, d.task_id, json(d));
  }
  updateDecision(d: Decision): void {
    this.db.run('UPDATE decisions SET status = ?, data = ? WHERE id = ?', d.status, json(d), d.id);
  }
  getDecision(id: string): Decision | undefined {
    const r = this.db.get('SELECT data FROM decisions WHERE id = ?', id);
    return r ? parse<Decision>(r.data) : undefined;
  }
  listDecisions(opts: { includeSuperseded?: boolean } = {}): Decision[] {
    const rows = opts.includeSuperseded
      ? this.db.all('SELECT data FROM decisions ORDER BY seq')
      : this.db.all(`SELECT data FROM decisions WHERE status = 'accepted' ORDER BY seq`);
    return rows.map((r) => parse<Decision>(r.data));
  }

  // ------------------------------------------------------------ context requests
  insertContextRequest(c: ContextRequest): void {
    this.db.run('INSERT INTO context_requests(id, task_id, status, data) VALUES (?, ?, ?, ?)', c.id, c.task_id, c.status, json(c));
  }
  updateContextRequest(c: ContextRequest): void {
    this.db.run('UPDATE context_requests SET status = ?, data = ? WHERE id = ?', c.status, json(c), c.id);
  }
  getContextRequest(id: string): ContextRequest | undefined {
    const r = this.db.get('SELECT data FROM context_requests WHERE id = ?', id);
    return r ? parse<ContextRequest>(r.data) : undefined;
  }
  listContextRequests(taskId: string): ContextRequest[] {
    return this.db.all('SELECT data FROM context_requests WHERE task_id = ? ORDER BY rowid', taskId).map((r) => parse<ContextRequest>(r.data));
  }

  // ------------------------------------------------------------ artifacts
  insertArtifact(a: ArtifactRow): void {
    this.db.run(
      `INSERT INTO artifacts(id, task_id, type, sha256, bytes, lines, estimated_tokens, file, created_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id, a.task_id, a.type, a.sha256, a.bytes, a.lines, a.estimated_tokens, a.file, a.created_at, json(a.meta),
    );
  }
  getArtifact(id: string): ArtifactRow | undefined {
    const r = this.db.get('SELECT * FROM artifacts WHERE id = ?', id);
    return r ? toArtifact(r) : undefined;
  }
  listArtifacts(taskId: string): ArtifactRow[] {
    return this.db.all('SELECT * FROM artifacts WHERE task_id = ? ORDER BY rowid', taskId).map(toArtifact);
  }

  // ------------------------------------------------------------ events
  appendEvent(e: { task_id: string | null; type: RuntimeEventType; actor: Actor; timestamp: string; payload: Record<string, unknown> }): void {
    this.db.run(
      'INSERT INTO runtime_events(task_id, type, actor, timestamp, payload) VALUES (?, ?, ?, ?, ?)',
      e.task_id, e.type, e.actor, e.timestamp, json(e.payload),
    );
  }
  listEvents(taskId?: string): RuntimeEvent[] {
    const rows = taskId
      ? this.db.all('SELECT * FROM runtime_events WHERE task_id = ? ORDER BY id', taskId)
      : this.db.all('SELECT * FROM runtime_events ORDER BY id');
    return rows.map((r) => ({
      id: Number(r.id),
      task_id: (r.task_id as string | null) ?? null,
      type: r.type as RuntimeEventType,
      actor: r.actor as Actor,
      timestamp: String(r.timestamp),
      payload: parse<Record<string, unknown>>(r.payload),
    }));
  }

  // ------------------------------------------------------------ tool calls
  insertToolCall(c: ToolCallRecord & { timestamp: string }): void {
    this.db.run(
      `INSERT INTO tool_calls(timestamp, endpoint, tool, task_id, request_tokens, response_tokens, ok, estimator)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      c.timestamp, c.endpoint, c.tool, c.task_id, c.request_tokens, c.response_tokens, c.ok ? 1 : 0, c.estimator,
    );
  }
  listToolCalls(taskId: string): (ToolCallRecord & { timestamp: string })[] {
    return this.db.all('SELECT * FROM tool_calls WHERE task_id = ? ORDER BY id', taskId).map((r) => ({
      timestamp: String(r.timestamp),
      endpoint: r.endpoint as ToolCallRecord['endpoint'],
      tool: String(r.tool),
      task_id: (r.task_id as string | null) ?? null,
      request_tokens: Number(r.request_tokens),
      response_tokens: Number(r.response_tokens),
      ok: Number(r.ok) === 1,
      estimator: String(r.estimator),
    }));
  }

  // ------------------------------------------------------------ agent sessions
  insertSession(s: SessionRow): void {
    this.db.run(
      'INSERT INTO agent_sessions(session_id, task_id, transcript_path, tool, timestamp) VALUES (?, ?, ?, ?, ?)',
      s.session_id, s.task_id, s.transcript_path, s.tool, s.timestamp,
    );
  }
  listSessions(taskId: string): SessionRow[] {
    return this.db.all<SessionRow>('SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY rowid', taskId);
  }
}

function toArtifact(r: Record<string, unknown>): ArtifactRow {
  return {
    id: String(r.id),
    task_id: (r.task_id as string | null) ?? null,
    type: r.type as ArtifactType,
    ref: `runtime://artifacts/${String(r.id)}`,
    sha256: String(r.sha256),
    bytes: Number(r.bytes),
    lines: Number(r.lines),
    estimated_tokens: Number(r.estimated_tokens),
    file: String(r.file),
    created_at: String(r.created_at),
    meta: parse<Record<string, unknown>>(r.meta ?? '{}'),
  };
}
