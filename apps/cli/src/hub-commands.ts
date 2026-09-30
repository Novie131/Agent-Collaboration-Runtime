import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { claudeTaskBundle } from '@acr/core/context/broker.js';
import { RESOLVE_TARGETS } from '@acr/core/task/machine.js';
import { findWorkspaceRoot, initWorkspace, localToken, openWorkspace, type OpenedWorkspace } from '@acr/mcp/workspace.js';
import { startHubServers } from '@acr/mcp/server.js';
import type { HubResponse } from '@acr/protocol/collaboration.js';
import { formatChecks, runDoctor } from './doctor.js';

const EXIT = { ok: 0, failed: 1, usage: 2 } as const;
const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

function workspace(opts: { withGit?: boolean } = {}): OpenedWorkspace {
  const root = findWorkspaceRoot(process.cwd());
  if (!root) throw new Error('not inside an ACR workspace; run `acr init` in the repository root first');
  return openWorkspace(root, { withGit: opts.withGit ?? false, tests: null });
}

/** Prints a hub response (JSON with --json) and maps it to an exit code. */
function show(res: HubResponse<unknown>, json: boolean, render?: (data: any) => string): number {
  if (json) out(JSON.stringify(res, null, 2));
  else if (!res.ok) err(`error ${res.error!.code}: ${res.error!.message}`);
  else out(render ? render(res.data) : JSON.stringify(res.data, null, 2));
  if (!json && res.next) out(`\nnext: ${res.next}`);
  return res.ok ? EXIT.ok : EXIT.failed;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

export function addHubCommands(program: Command, setExit: (code: number) => void) {
  const guard = (fn: () => Promise<number> | number) => async () => {
    try {
      setExit(await fn());
    } catch (e) {
      err(`acr: ${(e as Error).message}`);
      setExit(EXIT.failed);
    }
  };

  program
    .command('init')
    .description('Register this repository as an ACR workspace (.agent-runtime/config.json).')
    .option('--name <name>', 'display name (default: directory name)')
    .option('--id <id>', 'workspace id (default: derived from the name)')
    .action((o: { name?: string; id?: string }) =>
      guard(() => {
        const existing = findWorkspaceRoot(process.cwd());
        const r = initWorkspace(existing ?? process.cwd(), o);
        out(r.created ? `created ${r.file}` : `already initialised: ${r.file}`);
        out(`workspace: ${r.config.name} (${r.config.workspace_id})`);
        out('next: `acr start`, then `acr connect claude` and `acr connect chatgpt`');
        return EXIT.ok;
      })(),
    );

  program
    .command('start')
    .description('Run the hub: remote endpoint (ChatGPT) and local endpoint (Claude Code), both on 127.0.0.1.')
    .option('--remote-port <n>', 'override the remote port', (v) => Number(v))
    .option('--local-port <n>', 'override the local port', (v) => Number(v))
    .option('--remote-host <host...>', 'extra Host header value(s) accepted on the remote endpoint (for a bridge)')
    .action((o: { remotePort?: number; localPort?: number; remoteHost?: string[] }) =>
      guard(async () => {
        const root = findWorkspaceRoot(process.cwd());
        if (!root) throw new Error('not inside an ACR workspace; run `acr init` first');
        const ws = openWorkspace(root);
        const running = await startHubServers({
          hub: ws.hub,
          name: 'acr',
          ports: { remote: o.remotePort ?? ws.config.ports.remote, local: o.localPort ?? ws.config.ports.local },
          localToken: localToken(ws.config),
          ...(o.remoteHost ? { remoteHosts: o.remoteHost } : {}),
        });
        out(`ACR hub for ${ws.config.name} (${root})`);
        out(`  remote (ChatGPT):     ${running.remoteUrl}   (expose only via a bridge; see \`acr connect chatgpt\`)`);
        out(`  local  (Claude Code): ${running.localUrl}   (bearer token; see \`acr connect claude\`)`);
        const checks = runDoctor(ws, { fix: true });
        out(`Security checks:\n${formatChecks(checks)}`);
        if (checks.some((c) => c.status === 'fail')) out('  ✗ problems found above; run `acr doctor` for details. The hub is running anyway.');
        out('Ctrl+C to stop.');
        await new Promise<void>((resolve) => {
          const stop = () => resolve();
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
        await running.close();
        ws.close();
        out('hub stopped');
        return EXIT.ok;
      })(),
    );

  program
    .command('doctor')
    .description('Security checks: privacy guard, .env files, token placement, data permissions, disk encryption.')
    .option('--no-fix', 'report permission problems instead of fixing them')
    .option('--json', 'JSON output', false)
    .action((o: { fix: boolean; json: boolean }) =>
      guard(() => {
        const root = findWorkspaceRoot(process.cwd());
        if (!root) throw new Error('not inside an ACR workspace; run `acr init` first');
        const ws = openWorkspace(root, { withGit: false, tests: null });
        try {
          const checks = runDoctor(ws, { fix: o.fix });
          if (o.json) out(JSON.stringify(checks, null, 2));
          else out(`ACR security checks for ${ws.config.name} (${root})\n${formatChecks(checks)}`);
          return checks.some((c) => c.status === 'fail') ? EXIT.failed : EXIT.ok;
        } finally {
          ws.close();
        }
      })(),
    );

  program
    .command('status')
    .description('Open tasks and what each is waiting for.')
    .option('--json', 'JSON output', false)
    .action((o: { json: boolean }) =>
      guard(() => {
        const ws = workspace();
        try {
          const s = ws.hub.status();
          if (o.json) out(JSON.stringify({ workspace: ws.config.workspace_id, ...s }, null, 2));
          else {
            out(`Workspace: ${ws.config.name} (${ws.config.workspace_id})`);
            if (!s.open.length) out('No open tasks.');
            for (const t of s.open) out(`  ${pad(t.id, 6)} ${pad(t.state, 18)} ${pad(t.risk, 7)} ${t.title}${t.next ? `\n         next: ${t.next}` : ''}`);
          }
          return EXIT.ok;
        } finally {
          ws.close();
        }
      })(),
    );

  // -------------------------------------------------------------------- task
  const task = program.command('task').description('Inspect and control tasks (developer).');
  const withWs = <T>(fn: (ws: OpenedWorkspace) => Promise<T> | T) => {
    const ws = workspace();
    return Promise.resolve(fn(ws)).finally(() => ws.close());
  };

  task
    .command('list')
    .option('--all', 'include completed / cancelled', false)
    .option('--json', 'JSON output', false)
    .action((o: { all: boolean; json: boolean }) =>
      guard(() =>
        withWs(async (ws) =>
          show(await ws.hub.listTasks({ include_closed: o.all }), o.json, (d) =>
            d.tasks.length ? d.tasks.map((t: any) => `${pad(t.id, 6)} ${pad(t.state, 18)} ${pad(t.risk, 7)} ${t.title}`).join('\n') : 'No tasks.',
          ),
        ),
      )(),
    );

  task
    .command('show <id>')
    .option('--events', 'include the event log', false)
    .option('--json', 'JSON output', false)
    .action((id: string, o: { events: boolean; json: boolean }) =>
      guard(() =>
        withWs(async (ws) => {
          const code = show(await ws.hub.getTask(id), o.json);
          const result = ws.store.latestResult(id);
          if (result) {
            out('\nlatest result:');
            show(await ws.hub.getResult(id), o.json);
          }
          if (o.events) {
            out('\nevents:');
            for (const e of ws.hub.events(id)) out(`  ${e.timestamp}  ${pad(e.actor, 7)} ${pad(e.type, 22)} ${JSON.stringify(e.payload)}`);
          }
          return code;
        }),
      )(),
    );

  task
    .command('create')
    .description('Create a task from a JSON file (same fields as the create_task tool); useful without ChatGPT.')
    .requiredOption('--file <file>', 'task JSON')
    .option('--json', 'JSON output', false)
    .action((o: { file: string; json: boolean }) =>
      guard(() => withWs(async (ws) => show(await ws.hub.createTask(JSON.parse(readFileSync(o.file, 'utf8')), 'human'), o.json)))(),
    );

  task
    .command('accept <id>')
    .option('--force', 'override failed guards (recorded as a human override)', false)
    .option('--note <text>')
    .option('--json', 'JSON output', false)
    .action((id: string, o: { force: boolean; note?: string; json: boolean }) =>
      guard(() => withWs(async (ws) => show(await ws.hub.acceptTask(id, { force: o.force, actor: 'human', ...(o.note ? { note: o.note } : {}) }), o.json)))(),
    );

  task
    .command('cancel <id>')
    .option('--reason <text>')
    .option('--json', 'JSON output', false)
    .action((id: string, o: { reason?: string; json: boolean }) => guard(() => withWs(async (ws) => show(await ws.hub.cancelTask(id, 'human', o.reason), o.json)))());

  task
    .command('resolve <id>')
    .description('Resolve an ESCALATED task.')
    .addOption(new Option('--to <state>', 'new state').choices([...RESOLVE_TARGETS]).makeOptionMandatory())
    .option('--note <text>')
    .option('--json', 'JSON output', false)
    .action((id: string, o: { to: (typeof RESOLVE_TARGETS)[number]; note?: string; json: boolean }) =>
      guard(() => withWs(async (ws) => show(await ws.hub.resolveTask(id, o.to, o.note), o.json)))(),
    );

  // -------------------------------------------------------------------- context / decisions / metrics
  program
    .command('context')
    .description('Show what each side receives for a task right now (does not claim it).')
    .command('show <id>')
    .addOption(new Option('--for <side>', 'audience').choices(['claude', 'chatgpt']).default('claude'))
    .action((id: string, o: { for: 'claude' | 'chatgpt' }) =>
      guard(() =>
        withWs(async (ws) => {
          // Exactly what ChatGPT would receive, after the privacy guard (preview: nothing is recorded).
          if (o.for === 'chatgpt') return show(ws.hub.guardOutgoing('get_result', id, await ws.hub.getResult(id), false), true);
          const t = ws.store.getTask(id);
          if (!t) throw new Error(`task ${id} not found`);
          const bundle = claudeTaskBundle({ task: t, decisions: ws.store.listDecisions(), reviews: ws.store.listReviews(id), contextRequests: ws.store.listContextRequests(id) });
          out(JSON.stringify(bundle, null, 2));
          out(`\n≈ ${Math.ceil(JSON.stringify(bundle).length / 4)} tokens (estimate)`);
          return EXIT.ok;
        }),
      )(),
    );

  program
    .command('decisions')
    .command('list')
    .option('--all', 'include superseded', false)
    .option('--json', 'JSON output', false)
    .action((o: { all: boolean; json: boolean }) =>
      guard(() =>
        withWs(async (ws) =>
          show(await ws.hub.getDecisions({ include_superseded: o.all }), o.json, (d) =>
            d.decisions.length ? d.decisions.map((x: any) => `${pad(x.id, 7)} ${pad(x.status, 10)} ${x.title}${x.task_id ? ` (${x.task_id})` : ''}`).join('\n') : 'No decisions.',
          ),
        ),
      )(),
    );

  program
    .command('metrics <id>')
    .description('Token metrics for a task: Claude measured vs ChatGPT estimated (never summed).')
    .option('--json', 'JSON output', false)
    .action((id: string, o: { json: boolean }) =>
      guard(() =>
        withWs(async (ws) =>
          show(await ws.hub.getMetrics(id), o.json, (m) =>
            [
              `Task ${m.task_id}`,
              `  Claude (measured, ${m.claude.bound} bound): ${m.claude.tokens ?? `≥ ${m.claude.observed_tokens}`} tokens over ${m.claude.requests} request(s) in ${m.claude.sessions} session(s) [${m.claude.completeness}]`,
              `    breakdown: uncached input ${m.claude.breakdown.input_uncached} · cache read ${m.claude.breakdown.input_cache_read} · cache write ${m.claude.breakdown.input_cache_write} · output ${m.claude.breakdown.output}`,
              ...m.claude.gaps.map((g: string) => `    gap: ${g}`),
              `  ChatGPT tool I/O (estimated, lower bound, ${m.chatgpt.estimator}): ${m.chatgpt.tool_io_cumulative} cumulative (${m.chatgpt.tool_io_once} once) over ${m.chatgpt.tool_calls} call(s)`,
              `  Claude-side hub tool I/O: ${m.diagnostics.local_tool_io} over ${m.diagnostics.local_tool_calls} call(s)`,
              `  rounds: ${m.diagnostics.claims} claim(s), ${m.diagnostics.results} result(s), ${m.diagnostics.reviews} review(s), ${m.diagnostics.context_requests} context request(s)`,
              `  ${m.note}`,
            ].join('\n'),
          ),
        ),
      )(),
    );

  // -------------------------------------------------------------------- connect
  const connect = program.command('connect').description('How to connect Claude Code or ChatGPT to this hub.');
  connect
    .command('claude')
    .option('--scope <scope>', 'claude mcp scope (user keeps the token out of the repo)', 'user')
    .action((o: { scope: string }) =>
      guard(() =>
        withWs((ws) => {
          const token = localToken(ws.config);
          out('Register the local endpoint with Claude Code (token stays in your user config, not the repo):\n');
          out(`  claude mcp add --scope ${o.scope} --transport http acr http://127.0.0.1:${ws.config.ports.local}/mcp --header "Authorization: Bearer ${token}"\n`);
          // Hooks run without your shell aliases, so use absolute paths to node and this CLI.
          const self = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
          const hookCommand = `"${process.execPath}" "${self}" hook`;
          out('Optional, for per-task token measurement: add this PostToolUse hook to .claude/settings.json (or ~/.claude/settings.json):\n');
          out(
            JSON.stringify(
              { hooks: { PostToolUse: [{ matcher: 'mcp__acr__.*', hooks: [{ type: 'command', command: hookCommand }] }] } },
              null,
              2,
            ),
          );
          out('\nThen, in Claude Code: "Take the next ACR task."');
          return EXIT.ok;
        }),
      )(),
    );
  connect.command('chatgpt').action(() =>
    guard(() =>
      withWs((ws) => {
        out(`The remote endpoint listens on http://127.0.0.1:${ws.config.ports.remote}/mcp (127.0.0.1 only).`);
        out('ChatGPT Web cannot reach localhost. Expose ONLY the remote endpoint through the OpenAI Secure MCP Tunnel:');
        out('  1. Install OpenAI tunnel-client and create a tunnel in your Platform org (needs Tunnels Read + Use).');
        out(`  2. Point it at http://127.0.0.1:${ws.config.ports.remote}/mcp (unverified flag name: --mcp-server-url).`);
        out('  3. In ChatGPT: Settings → Security → Developer mode on; then Plugins → Create MCP App → choose the tunnel.');
        out('Never expose the local endpoint. Other bridges (ngrok, cloudflared) are not allowed until the hub has OAuth (ADR-0004).');
        return EXIT.ok;
      }),
    )(),
  );

  // -------------------------------------------------------------------- hook
  program
    .command('hook')
    .description('Claude Code PostToolUse hook: records which session worked on which task. Always exits 0.')
    .action(async () => {
      // A hook must never break Claude's tool call, so every failure is swallowed.
      try {
        const input = JSON.parse(readFileSync(0, 'utf8')) as {
          session_id?: string;
          transcript_path?: string;
          tool_name?: string;
          tool_input?: Record<string, unknown>;
          tool_response?: unknown;
          cwd?: string;
        };
        const m = /^mcp__.+?__(get_task|submit_result|respond_review|run_tests|fulfill_context|report_blocked)$/.exec(input.tool_name ?? '');
        if (!m || !input.session_id || !input.transcript_path) return setExit(0);
        const fromInput = typeof input.tool_input?.task_id === 'string' ? input.tool_input.task_id : undefined;
        const fromResponse = /"(?:task_id|id)\\?"\s*:\s*\\?"(T-\d+)/.exec(JSON.stringify(input.tool_response ?? ''))?.[1];
        const taskId = fromInput ?? fromResponse;
        const root = findWorkspaceRoot(input.cwd ?? process.cwd());
        if (!taskId || !root) return setExit(0);
        const ws = openWorkspace(root, { withGit: false, tests: null });
        try {
          await ws.hub.reportSession({ session_id: input.session_id, transcript_path: input.transcript_path, task_id: taskId, tool: m[1]! });
        } finally {
          ws.close();
        }
      } catch {
        // ignore
      }
      setExit(0);
    });
}
