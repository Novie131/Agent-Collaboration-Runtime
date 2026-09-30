# Agent Collaboration Runtime — SPEC.md

> Cross-platform, token-aware collaboration runtime for **ChatGPT Web + Claude Code (CLI / VS Code)**.
>
> Primary development environment: **macOS** · Required runtime support: **macOS / Windows / Linux**

| | |
|---|---|
| Spec version | 2 (2026-09-30) |
| Status | Accepted for implementation. No code for v2 exists yet. |
| Supersedes | Draft v1 of this file ([archive](archive/agent-collaboration-runtime-SPEC.v1-draft.md)). It also absorbs the legacy prototype specified in `Document/plan/agent-efficiency-spec.md` v0.2 (in git history at commit `cc0229b`). |
| Decisions | [docs/adr/](../../docs/adr/). Each ADR explains *why*; this SPEC states *what*. |
| Feasibility | [feasibility.md](feasibility.md) |
| Glossary | [CONTEXT.md](../../CONTEXT.md) |

Key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

Platform facts in this document were verified on 2026-09-29. They change quickly. §38 lists the ones that must be re-verified before the work that depends on them starts.

---

## 0. Summary

ACR is a **local hub** that sits between two coding assistants the developer already uses:

- **ChatGPT Web**: architect, reviewer, the developer's thinking partner.
- **Claude Code** (CLI or VS Code): implementer that works in the local repository.

The two assistants never share conversations. They share **tasks, results, evidence, decisions and artifacts** through the hub. The hub keeps what each side receives as small as correctness allows.

The **developer drives every step.** Neither assistant can be woken by the hub (§2.2). The hub is a stateful mailbox and gatekeeper. It is not an autonomous orchestrator.

Core principle:

> **Same or better task quality with less cross-agent context and fewer tokens, and the savings must be shown by measurement, not assumed.**

---

## 1. Problem Statement

Today, developers use ChatGPT and Claude Code separately. Collaboration between them is manual:

1. Discuss architecture in ChatGPT.
2. Copy requirements into Claude Code.
3. Claude Code reads the repository and implements changes.
4. Copy Claude's result back into ChatGPT.
5. Ask ChatGPT to review.
6. Copy review comments back into Claude.
7. Repeat.

Problems: duplicated context, repeated explanations, excess tokens, lost decisions, weak traceability, unclear ownership, unnecessary review cycles, large pasted blobs that stay in the ChatGPT conversation for every later turn, and inconsistent handoffs.

This manual workflow is also the **baseline** ACR is measured against (§30).

---

## 2. Product Shape

### 2.1 Topology

```text
            Developer (drives every step)
             │                        │
             ▼                        ▼
       ChatGPT Web               Claude Code (CLI / VS Code)
   Architect / Reviewer            Implementer, pull mode
             │                        │
   MCP over Streamable HTTP     MCP over Streamable HTTP
             │                        │
   OpenAI Secure MCP Tunnel           │  127.0.0.1 only,
   (outbound-only, org-scoped)        │  never tunneled
             │                        │
   ┌─────────▼────────────────────────▼─────────┐
   │  ACR Hub  (one local process: `acr start`) │
   │                                            │
   │  remote endpoint      local endpoint       │
   │  (ChatGPT tools)      (Claude tools)       │
   │                                            │
   │  Task store · Decision Ledger · Artifacts  │
   │  Context Broker · Compression · Verifier   │
   │  Limits · Telemetry · Event log (SQLite)   │
   └─────────────────────┬──────────────────────┘
                         │ read-only git / files
                         ▼
                     Repository
```

### 2.2 Who drives

These facts shape the whole design (verified 2026-09-29, [ADR-0003](../../docs/adr/0003-human-driven-hub.md)):

- ChatGPT calls MCP tools **only during a turn the user started**. No external server can wake or resume a conversation.
- Claude Code in MVP runs in **pull mode**: the developer tells their own session to fetch work ([ADR-0005](../../docs/adr/0005-claude-pull-mode-first.md)).

The hub therefore:

| Does | Does not |
|---|---|
| Store tasks, results, reviews, decisions, artifacts | Wake or schedule either assistant |
| Decide **what is returned** to each side, and how compactly | Decide on its own which assistant acts next |
| **Suggest** the next step in every response (`next`) | Run models (in MVP) |
| **Refuse** requests that break limits or policy (§18, §17) | Expose Claude-side tools to ChatGPT |
| Verify Claude's claims against git and test artifacts (§21) | Scrape or automate any UI |

In phase 2, the Agent SDK adapter lets the hub run Claude directly (§25.3). Routing on the Claude side then becomes real dispatch. The ChatGPT side remains human-driven.

---

## 3. Primary Goal

> **Reduce total token usage of a multi-agent coding task without reducing correctness, completion quality, or developer control.**

We optimize **quality per token**, not the smallest prompt. How tokens are counted, and which claims are allowed, is defined in §29–§30. In short:

- Claude-side tokens are **measured**.
- ChatGPT-side tokens are **estimated** and always labelled as such.
- The two are never added into one number.

---

## 4. Non-Goals

The MVP MUST NOT:

- replace Claude Code or ChatGPT, or build a coding model;
- become a general-purpose agent framework;
- scrape the ChatGPT DOM or automate browser clicks ([ADR-0010](../../docs/adr/0010-no-ui-automation.md));
- claim to orchestrate ChatGPT autonomously;
- spawn `claude -p` on the user's claude.ai subscription login ([ADR-0005](../../docs/adr/0005-claude-pull-mode-first.md));
- rely on Claude Code Channels (research preview);
- synchronize conversations or share full agent context by default;
- implement free-form multi-agent debate;
- require Docker, Redis, Kafka, PostgreSQL or other infrastructure;
- assume a POSIX shell or depend on macOS-only APIs;
- send telemetry anywhere outside the local machine.

---

## 5. Supported Platforms

The runtime MUST support macOS, Windows 11, and mainstream Linux distributions. macOS is the primary development environment, but no decision may make Windows or Linux second-class.

Claude Code runs natively on Windows (10 1809+). WSL is not required. Whether `tunnel-client` supports all three platforms is **not yet verified** (§38).

---

## 6. Cross-Platform Rules

These are hard requirements.

1. **Paths.** Build paths only with `node:path` (`path.join`, `path.resolve`), never string concatenation. Test with `/Users/lily/project`, `/home/user/project`, `C:\Users\Test User\Projects\Demo App`.
2. **Processes.** Never `spawn("bash", ["-c", …])`. Use `spawn(cmd, args, { shell: false })`. If a shell is unavoidable, go through `packages/platform/shell.ts`. Core logic MUST NOT live in `.sh`/`.zsh` files.
3. **Environment.** Read `process.env`. Documentation shows both `export ACR_PORT=8787` and PowerShell `$env:ACR_PORT="8787"`.
4. **IPC.** Do not rely on Unix-only signals (`SIGUSR1/2`). Coordinate via localhost HTTP, stdio, local files or SQLite. Graceful shutdown handles `SIGINT`/`SIGTERM` where available and Ctrl+C on Windows.
5. **Locking.** No POSIX `flock`. SQLite transactions are the coordination mechanism.
6. **Networking.** Bind `127.0.0.1` only. Nothing listens on a public interface. Remote reachability comes solely from a `RemoteBridge` (§27).
7. **Executables.** Resolve through `PATH` (`claude`, `claude.exe`, `tunnel-client`, `git`). Every executable path is configurable, and none is hard-coded.
8. **npm scripts** must run on Windows. Use Node scripts instead of `rm -rf` and similar.

---

## 7. Technology Stack

| Concern | Choice | Note |
|---|---|---|
| Runtime | **Node.js 24+** | Draft v1 said 22+. Raised for `node:sqlite` ([ADR-0008](../../docs/adr/0008-node-sqlite-node24.md)). CI runs 24 and 26. |
| Language / packages | TypeScript (strict), pnpm workspaces | |
| CLI | commander | Already used by the legacy modules |
| Validation / protocol | zod | Already used by the legacy modules |
| Storage | `node:sqlite` behind `packages/storage` interface | Swappable to `better-sqlite3` by changing one module |
| MCP server | Official MCP TypeScript SDK, Streamable HTTP transport | Pin the version. Verify its support for the 2026-07-28 spec revision before adoption (§38). |
| HTTP | `node:http` (via MCP SDK) | Fastify/ws from draft v1 are dropped unless a concrete need appears |
| Logging | Small structured JSON logger in `packages/platform` | pino only if needed |
| Tests | Vitest | |
| Build | `tsc` project references | tsup only if bundling is needed |

Keep dependencies minimal. No NestJS.

---

## 8. Naming

Working name **ACR (Agent Collaboration Runtime)**, CLI `acr`. The legacy name "Agent Efficiency" / `agent-efficiency` is retired. Naming must stay replaceable. Protocol fields and schema names MUST NOT contain product branding.

---

## 9. Architecture Layers

[ADR-0002](../../docs/adr/0002-layered-offline-core.md) splits the code into two layers.

### 9.1 Core (offline)

`protocol`, `storage`, `core/*`, `compression`, `artifacts`, `security`, `benchmark` (statistics only), `telemetry` (analysis only), `platform`.

Core packages MUST:

- never open network connections;
- never spawn an agent or call a model;
- be fully testable with no Claude Code, no tunnel and no API key.

### 9.2 Edges (opt-in)

`adapters/*`, `remote-bridge`, `mcp` (the hub process), `git`, `runner`, and the Tier 1 benchmark runner. These MAY use the network or start agents, but **only when the user has explicitly enabled them** in config or with a CLI flag.

### 9.3 Enforcement

A repository check (lint rule or dependency-cruiser style script run in CI) fails if a core package imports any of:

- `node:http`, `node:https`, `node:net`, `node:child_process`;
- the MCP SDK;
- any `adapters/*` or `remote-bridge` package.

The one exception is `compression`'s test runner (§20.3), which spawns the project's local Jest. It lives in a separate `packages/runner` package that counts as an edge.

### 9.4 Telemetry

Telemetry is written only to local SQLite and is never uploaded.

---

## 10. Legacy Modules

The legacy "Agent Efficiency" prototype (`src/`) holds the only token-saving and measurement code that already works and is tested. It is **moved, not rewritten** ([ADR-0001](../../docs/adr/0001-monorepo-reusing-legacy-modules.md)).

| Legacy module | New package | Role in ACR |
|---|---|---|
| `src/artifacts/` (+ `expand`, `prune`) | `packages/artifacts` | §20 artifact store, range reads |
| `src/renderers/` | `packages/compression` | §19 deterministic compression; Jest result view |
| `src/runner/`, `src/policies/` (Jest spawn, arg deny-list, modes, jest-gate, policy registry/state) | `packages/runner` (edge) | Claude-side `run_tests` tool; integrity gate. Policies live here because the registry depends on the artifact store, which depends on compression. |
| `src/evaluate/` (Tango, cluster bootstrap, gates) | `packages/benchmark` | §30 statistical gates |
| `src/privacy/redact.ts` | `packages/security` | §28 redaction |
| `src/adapters/*` (claude-code, canonical, jsonl, registry), `src/observe/usage.ts` | `packages/transcripts` (offline) | §29 measured Claude usage; canonical transcript format |
| `src/observe/rules.ts`, `analyze.ts` (R001–R004) | `packages/telemetry` | §29.4 waste diagnostics on task transcripts |
| `src/schema/events.ts` | `packages/protocol` as **TranscriptEvent** | Agent-transcript events, kept distinct from **RuntimeEvent** (§24) |
| `src/schema/evaluation.ts` | `packages/benchmark` | Task / run / experiment manifests |
| `src/report/` | `packages/telemetry` (analysis report), `packages/benchmark` (comparison report), `packages/platform` (safe report writing) | Human-readable reports |
| `fixtures/real/*`, `fixtures/synthetic/*` | `fixtures/` (unchanged) | Real Jest 29.7.0 output; de-identified Claude Code transcript |
| `scripts/*.mjs` | `scripts/` | Fixture capture, de-identification, usage reconciliation |

Legacy CLI commands stay available as `acr test`, `acr expand`, `acr analyze`, `acr compare`, `acr prune`, `acr policies`, `acr adapters`. The Codex "unsupported" listing is dropped.

**Migration comes first** (Phase 0, §35). All legacy tests must pass in the monorepo before any hub code is written.

---

## 11. Agent Roles

### ChatGPT (via remote endpoint)

**Responsibilities:** architect, requirement clarifier, reviewer, risk assessor, decision-maker together with the developer.

**Receives by default:** requirements it wrote, active decisions, compact results, verification findings, test summaries, and artifact references.

**On request, within scope (§14.2):** diffs, file ranges and artifact ranges.

**Never receives automatically:**
- files outside the task scope;
- Claude's transcript;
- raw shell output;
- tool-call history;
- any Claude-side tool.

### Claude Code (via local endpoint)

**Responsibilities:** repository inspection, implementation, refactoring, testing, local debugging, evidence collection, and fulfilling context requests.

**Receives by default:** task goal, scope, constraints, acceptance criteria, relevant decisions, review comments addressed to it, and context requests.

**Never receives:** the ChatGPT conversation, brainstorming, or unrelated history.

---

## 12. Minimum Necessary Context

Every context transfer must answer: *why does this agent need this for its next action?*

### 12.1 Where the tokens actually go

The draft assumed the handoff payload was the main cost. It is not: a task is a few hundred tokens. The real levers, in order:

1. **Tool results returned to ChatGPT.** A ChatGPT conversation re-reads its whole history every turn. A 5,000-token diff pasted in turn 3 is paid for again in every later turn. `get_result` therefore returns a compact view with artifact references (§19), and details are fetched by range only when needed.
2. **Claude re-exploring the repository.** Decisions, precise scope, and file references in the task reduce repeated reads and searches. The waste diagnostics R001–R004 (§29.4) measure this.
3. **Claude's own tool output.** The Jest view with its integrity gate (§20.3) returns compact test results to Claude, with raw output one `expand` away.
4. **Handoff payloads.** They are small already, so structure matters more than size here.

### 12.2 Context item

```ts
type ContextType =
  | "requirement" | "constraint" | "architecture" | "source" | "diff"
  | "test" | "runtime_error" | "decision" | "uncertainty" | "review_comment";

type ContextItem = {
  id: string;
  taskId: string;
  type: ContextType;
  source: string;          // provenance: tool, file, actor
  content?: string;        // inline only when small (§19.2)
  artifactRef?: string;    // otherwise a reference
  estimatedTokens: number;
  priority: "critical" | "high" | "normal" | "low";
  expiresAt?: string;
};
```

### 12.3 Priority when budget is limited

1. Task goal
2. Constraints
3. Acceptance criteria
4. Active decisions
5. Verification findings
6. Exact relevant source
7. Failing tests / errors
8. Relevant diff
9. Historical context

Historical conversation is lowest and is never included unless explicitly requested.

---

## 13. Interaction Flow

The developer is the clock. The first end-to-end demo (§36) follows this path.

```text
Developer → ChatGPT: "Add a health-check endpoint."
ChatGPT → remote.create_task(goal, scope, constraints, acceptance, risk)
           [ChatGPT asks the user to confirm the write tool]
Hub      ← task T-1 READY; next: "Ask Claude Code to take task T-1."

Developer → Claude Code: "Take the next ACR task."
Claude   → local.get_task()                 → task T-1, CLAIMED (base commit recorded)
Claude   … reads files, edits, local.run_tests(...) → compact view + artifact
Claude   → local.submit_result(T-1, ...)     → IMPLEMENTED
Hub        verifies: git diff vs claimed files; tests vs run_tests artifact
Hub      ← next: "Review is optional (risk: medium). Ask ChatGPT to check T-1."

Developer → ChatGPT: "Check T-1."
ChatGPT → remote.get_result(T-1)   (read-only, no confirmation)
           → summary, changed files, test summary, verification findings,
             uncertainties, artifact refs, token metrics
  if no concern:  remote.accept_task(T-1) → COMPLETED
  if concern:     remote.get_diff(T-1, path, range) / remote.read_file(...)
                  remote.submit_review(T-1, changes_requested, comments)
                  → next: "Ask Claude Code to address review R-1 on T-1."
Developer → Claude Code: "Handle the ACR review."
Claude   → local.get_task() → T-1 with review R-1 → fixes →
           local.respond_review(R-1, ...) + local.submit_result(T-1, ...)
… until accepted, or a limit is hit and the hub escalates to the developer.
```

Every response on both endpoints carries a `next` hint (§14.3). The hint is advice to the developer and the assistant. It is never an automatic action.

---

## 14. MCP Surface

There are two endpoints, served by one process, **each on its own port** (defaults: remote 8787, local 8788), both bound to `127.0.0.1` and served at `/mcp` ([ADR-0004](../../docs/adr/0004-two-mcp-endpoints.md)). Separate ports mean a bridge that forwards arbitrary paths still cannot reach the local tools. Both are stateless Streamable HTTP servers (a fresh MCP server per request). Tools expose **business operations**, never database access or shell execution.

### 14.1 Remote endpoint (ChatGPT) — reachable only through a `RemoteBridge`

| Tool | `readOnlyHint` | Purpose |
|---|---|---|
| `create_task` | no | Create a task (hub assigns the ID) |
| `list_tasks` | yes | Tasks for the current project, with status |
| `get_task` | yes | One task, its state, reviews, and pending requests |
| `get_result` | yes | Compact result + verification + metrics (§19) |
| `get_diff` | yes | Hub-computed git diff for the task, optionally per file and line range |
| `read_file` | yes | File range, **only within the task's file scope** (§14.2) |
| `get_artifact` | yes | Artifact content by ID and range (§20) |
| `request_context` | no | Ask Claude for something outside scope (§14.2) |
| `submit_review` | no | Verdict `approve` \| `changes_requested` + structured comments (§15.3) |
| `record_decision` | no | Add or supersede a decision |
| `get_decisions` | yes | Active decisions, filtered by task or tag |
| `accept_task` | no | Mark complete (guarded by §17.3) |
| `cancel_task` | no | Cancel |
| `get_metrics` | yes | Token metrics for a task (§29) |

Read tools MUST set `readOnlyHint: true`. ChatGPT treats tools without it as writes and asks the user to confirm each call. That confirmation stays on for write tools by design.

### 14.2 File scope for ChatGPT

ChatGPT may read, without involving Claude ([ADR-0009](../../docs/adr/0009-scoped-read-access-for-chatgpt.md)):

- artifacts attached to the task;
- files matching the task's `scope.paths`;
- files changed in the task's hub-computed diff.

Reads are always limited to the workspace root, pass the secret deny-list and redaction (§28), and include `estimatedTokens`. Files over a threshold (default 400 lines) require an explicit line range.

Anything else goes through `request_context`. The request appears in Claude's next `get_task`, and Claude answers with `fulfill_context`. The answer usually arrives as an artifact.

### 14.3 Local endpoint (Claude Code) — `127.0.0.1` only, never bridged

The local endpoint additionally requires a per-workspace **bearer token** (kept in the project data directory, registered with `claude mcp add --scope user`, never in the repository) and enables DNS-rebinding protection (only `127.0.0.1:<port>` / `localhost:<port>` Host headers), so browser pages and other users' processes cannot call Claude's tools.

| Tool | Purpose |
|---|---|
| `get_task` | Claim the next READY task, or fetch a specific one with pending reviews and context requests |
| `submit_result` | Structured result (§15.2). Triggers verification (§21). |
| `respond_review` | Answer review comments (accept, reject with evidence, or fixed) |
| `fulfill_context` | Answer a `request_context` |
| `report_blocked` | Move the task to BLOCKED with a reason and a question |
| `get_decisions` | Active decisions |
| `run_tests` | Run the project's local Jest via `packages/runner`. Returns a view or raw output per mode, and stores an artifact. |
| `expand` | Retrieve omitted parts of an artifact. Never re-runs anything. |

### 14.4 Response envelope

Every tool response on both endpoints uses this envelope:

```ts
type HubResponse<T> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };   // e.g. LIMIT_EXCEEDED, OUT_OF_SCOPE
  next?: string;                                 // suggested next step for the developer
  estimatedTokens: number;                       // size of this response
};
```

---

## 15. Protocol Payloads

All schemas live in `packages/protocol` as versioned zod schemas. Adapters MUST NOT invent payload formats. Every payload carries `version`.

### 15.1 Task

```yaml
version: 1
task:
  id: T-21                 # assigned by the hub; a create_task input never contains it
  title: Implement OAuth token validation
  type: implementation     # implementation | bugfix | refactor | investigation | docs
  risk: high               # set by ChatGPT; the hub may raise it (§17.2)
workspace: demo-api        # registered via `acr init`; one workspace per task
goal: Implement OAuth token validation middleware.
scope:
  paths: [src/auth/, src/config/auth.ts]
constraints:
  - Preserve existing session login.
  - Do not change database schema.
acceptance:
  - Existing auth tests pass.
  - New OAuth validation tests pass.
context_refs: [DEC-9]
```

### 15.2 Result (submitted by Claude)

```yaml
version: 1
result:
  task_id: T-21
  status: completed        # completed | partial | blocked
changes:
  - path: src/auth/oauth.ts
    summary: Added access-token validation.
tests:
  artifact: ART-44         # run_tests artifact; claimed counts are checked against it
  passed: 38
  failed: 0
decisions:
  - OAuth validation runs before legacy cookie fallback.
uncertainties:
  - Refresh-token rotation is not implemented.
review:
  recommended: true
  focus: [refresh-token lifecycle]
evidence:
  - src/auth/oauth.ts:41-109
```

The hub appends a **verification** block (§21). ChatGPT sees Claude's claims and the hub's findings side by side. Full tool history is never returned.

### 15.3 Review (replaces the draft's separate Challenge protocol)

A review is a verdict plus structured comments. A comment with `severity: high` blocks acceptance until it is resolved. This covers what the draft called a "challenge" with one concept instead of two.

```yaml
version: 1
review:
  id: R-3
  task_id: T-21
  round: 1
  verdict: changes_requested   # approve | changes_requested
comments:
  - id: R-3.1
    claim: "OAuth migration is backward compatible."
    reason: "Legacy cookie fallback appears to be removed."
    severity: high             # low | medium | high
    evidence: [src/auth/middleware.ts:118]
    requested_action: inspect_and_respond
```

Claude answers with `respond_review`:

```yaml
version: 1
review_response:
  review_id: R-3
  items:
    - comment_id: R-3.1
      outcome: fixed          # fixed | rejected | acknowledged
      action: restored_legacy_cookie_fallback
      evidence: [src/auth/middleware.ts:121-146, test/auth/session.test.ts]
```

A `rejected` outcome MUST carry evidence. Free-form debate is not supported. Unresolved disagreement after the round limit escalates to the developer (§18).

### 15.4 Decision

```yaml
version: 1
decision:
  id: DEC-9
  task_id: T-21            # optional; decisions may be project-wide
  title: Preserve legacy cookie fallback
  status: accepted         # proposed | accepted | superseded
  supersedes: null
  reason: OAuth migration must remain backward compatible.
  evidence: [existing session tests]
  created_by: chatgpt      # chatgpt | claude | human
  created_at: 2026-09-29T10:00:00+08:00
```

### 15.5 Communication rules

Payloads follow **claim → evidence → response → decision**. Agreement and acknowledgement chatter has no payload type and is therefore not transmitted.

---

## 16. Task State Machine

Review status is an **attribute** of the task (latest verdict, open high-severity comments), not a state. Reading a diff therefore never changes state.

```text
create ──► READY ──► CLAIMED ──► IMPLEMENTED ──accept_task──► COMPLETED
                        │  ▲          │
                        ▼  │          │ submit_review(changes_requested)
                     BLOCKED          ▼
                               CHANGES_REQUESTED ──get_task──► CLAIMED

any non-terminal ──► CANCELLED        any non-terminal ──limit hit──► ESCALATED ──developer──► READY | COMPLETED | FAILED | CANCELLED
```

| Transition | Trigger | Guard |
|---|---|---|
| (new) → READY | `create_task` (validation passed) | Schema valid. CREATED is not persisted: a task that fails validation is never stored. |
| READY → CLAIMED | `local.get_task` | Records base commit and claim time; turn count +1 |
| CLAIMED → BLOCKED | `report_blocked` | — |
| BLOCKED → CLAIMED | Answer recorded (`record_decision`, task update) and Claude calls `get_task` | — |
| CLAIMED → IMPLEMENTED | `submit_result` | Result schema valid; verification runs (§21) |
| IMPLEMENTED → IMPLEMENTED | `submit_review(approve)` | Records approval; no state change |
| IMPLEMENTED → CHANGES_REQUESTED | `submit_review(changes_requested)` | Review rounds < `max_review_rounds` (§18) |
| CHANGES_REQUESTED → CLAIMED | `local.get_task` | Turn count +1 (limit §18) |
| IMPLEMENTED → COMPLETED | `accept_task` | §17.3 guards, or `acr task accept --force` |
| any non-terminal → ESCALATED | A limit in §18 is hit, or Claude reports `status: blocked` twice | — |
| ESCALATED → READY / COMPLETED / FAILED / CANCELLED | Developer via `acr task resolve` | Human actor only |
| any non-terminal → CANCELLED | `cancel_task` / `acr task cancel` | — |

Terminal states: `COMPLETED`, `FAILED`, `CANCELLED`. `FAILED` is only ever set by the developer.

Every transition appends a RuntimeEvent (§24). State is always derivable from the event log.

---

## 17. Risk and Review Policy

### 17.1 Who sets risk

ChatGPT sets `risk` in `create_task`. Automatic classification is deferred.

### 17.2 Hub minimum-risk rules

Path rules (configurable globs) set a **minimum** risk. The hub raises a lower value and says so in the response. Defaults:

| Minimum | Paths / signals |
|---|---|
| high | `**/auth/**`, `**/authz/**`, `**/payment*/**`, `**/migrations/**`, `**/*secret*`, `**/.env*`; tasks whose constraints mention deletion or public API breaks |
| medium | anything outside `docs/`, `*.md`, comments-only or formatting-only changes |
| low | `docs/**`, `**/*.md` |

The rules are re-applied at `submit_result` using the **actual** changed files. A "low" docs task that touched `src/auth/` becomes high.

### 17.3 Completion guards

| Risk | Review | `accept_task` refused when |
|---|---|---|
| low | skipped (hub suggests none) | verification found a mismatch |
| medium | optional (hub suggests one if uncertainties or mismatches exist) | verification found a mismatch, or an unresolved high-severity comment exists |
| high | **required** | no `approve` review, or any unresolved high-severity comment, or verification mismatch |

The developer can override any guard from the CLI (`acr task accept --force`). The override is recorded as an event with actor `human`.

---

## 18. Limits (MVP Token Governor)

The draft's full Token Governor (CONTINUE/REQUEST_CONTEXT/… decisions from many inputs) is deferred. The MVP enforces **hard limits** and **refuses** past them:

| Limit | Default | When exceeded |
|---|---|---|
| `max_agent_turns` (Claude claims + submits per task) | 8 | `get_task` refuses; task → ESCALATED |
| `max_review_rounds` | 2 | `submit_review(changes_requested)` refuses; task → ESCALATED |
| `max_context_requests` | 4 | `request_context` refuses; task → ESCALATED |
| `max_response_tokens` (per remote response) | 4,000 est. | Response is truncated to a view with artifact refs; never silently cut |

Escalate to the developer on:
- repeated failure;
- conflicting requirements;
- security-sensitive uncertainty;
- any limit exceeded;
- unresolved disagreement.

Phase 2 (SDK adapter) adds real budget enforcement via `maxBudgetUsd` / `maxTurns` on Claude runs.

---

## 19. Context Broker

The Context Broker builds every response that carries task content: `get_task` for Claude and `get_result`/`get_task` for ChatGPT.

```ts
interface ContextBroker {
  build(request: ContextRequest): ContextBundle;   // pure, offline, deterministic
}

type ContextRequest = {
  taskId: string;
  audience: "chatgpt" | "claude";
  purpose: "implement" | "review" | "debug" | "plan" | "respond";
  tokenBudget?: number;
  requiredTypes?: ContextType[];
};
```

### 19.1 Responsibilities

Select, rank (§12.3), deduplicate, estimate tokens, track provenance, replace large content with artifact references, and expire stale items.

### 19.2 Inline versus reference

Content up to `inline_threshold_tokens` (default 300) is inlined. Anything larger is stored as an artifact and returned as a reference with `estimatedTokens` and a short deterministic view (§20.2). ChatGPT fetches ranges only when needed.

### 19.3 Compression is deterministic

Allowed techniques:
- deduplication;
- repeated-log removal;
- failing-test extraction (Jest view);
- diffstat plus per-file hunks;
- path indexing;
- structured metadata.

No LLM summarization in MVP. LLM compression may be evaluated later, but only through the benchmark (§30).

### 19.4 Context cache (deferred)

The draft's "do not resend what the agent has already seen" cache is **deferred**. The hub cannot observe what remains in a ChatGPT conversation: the user may open a new chat, or the conversation may be compacted. Skipping content based on a guess would silently remove context. It may be revisited when a reliable signal exists.

---

## 20. Artifacts and Compression

### 20.1 Artifact store (legacy `artifacts`)

Large content is stored, hashed (SHA-256) and referenced:

```yaml
artifact:
  id: ART-99
  type: diff | test_output | file_snapshot | context_answer | log
  ref: runtime://artifacts/ART-99
  estimated_tokens: 8120
  sha256: …
```

`get_artifact` / `expand` return a range:

```yaml
artifact_request: { id: ART-99, range: { start: 120, end: 220 } }
```

Stored content is redacted on read by default (§28). Raw access needs an explicit flag and is available on the local endpoint only.

### 20.2 Views

Every artifact type has a deterministic view: diffstat, failing tests only, first/last N log lines with counts. A view is returned only when it is **smaller** than the raw content. Otherwise the raw content is returned with the reason. This is the legacy "view must be smaller" gate.

### 20.3 Test runner (legacy `runner` + `compression`)

`run_tests` keeps the legacy behavior:

- It runs the project's local Jest **once** with `shell: false`.
- It stores raw stdout/stderr and the JSON result.
- It applies the 5-step integrity gate.
- It returns the view only in `optimize` mode and only when every gate passes.
- It **never re-runs**.

The modes stay `shadow` (default) | `optimize` | `passthrough`. MVP supports Jest only, and only versions validated by fixtures (29.7.0 today).

---

## 21. Result Verification

When `submit_result` arrives, the hub checks the claims and does not simply relay them:

| Check | Method | Finding if mismatched |
|---|---|---|
| Changed files | `git diff --name-only <base>` (read-only git, `shell: false`) vs `changes[].path` | `unclaimed_change` / `claimed_but_unchanged` |
| Scope | Actual changed files vs `scope.paths` | `out_of_scope_change` |
| Tests | Claimed counts vs the referenced `run_tests` artifact. No artifact → `tests_unverified`. | `test_count_mismatch` |
| Risk | §17.2 rules on actual files | `risk_raised` |

Findings go into the result's `verification` block. `get_result` always shows them. Verification never modifies the repository.

---

## 22. Decision Ledger

Decisions are stored separately from any conversation (§15.4). They are superseded, never edited in place. `get_task` includes active decisions referenced by the task or tagged to its scope. The ledger exists so that neither assistant re-derives settled reasoning.

---

## 23. Storage

### 23.1 SQLite (authoritative)

- `node:sqlite` behind the `packages/storage` interface ([ADR-0008](../../docs/adr/0008-node-sqlite-node24.md)).
- One database per project, located in the OS application-data directory:
  - macOS: `~/Library/Application Support/agent-collaboration-runtime/`
  - Windows: `%APPDATA%\agent-collaboration-runtime\`
  - Linux: `$XDG_CONFIG_HOME/agent-collaboration-runtime/` (default `~/.config/…`), with data under `$XDG_DATA_HOME` where appropriate.
- All paths are resolved in one place: `getAppDataDirectory()` in `packages/platform`.

Tables:
- `projects`, `tasks`, `runtime_events`, `context_items`, `decisions`, `reviews`, `review_comments`, `context_requests`;
- `artifacts` (metadata; content lives on disk next to the DB);
- `agent_sessions`, `token_usage`, `tool_io` (§29).

The migration runner is versioned (`PRAGMA user_version`); a database newer than the build is refused. `ACR_HOME` overrides the data directory (tests, demos, portable installs).

### 23.2 Per-repository directory

```text
.agent-runtime/
├── config.json      # workspace id, risk path rules, limits, runner mode
├── logs/
└── exports/         # `acr export` dumps (JSON), never authoritative
```

`acr init` creates this directory and registers the workspace root. Authoritative state lives only in SQLite. The directory should be git-ignored except `config.json`.

---

## 24. Event Model

Two event families with distinct names ([CONTEXT.md](../../CONTEXT.md)):

- **RuntimeEvent** records what happened to tasks in the hub. It is append-only and is the audit log.
- **TranscriptEvent** is the legacy canonical agent-transcript event (tool_call, tool_result, usage, …). It is parsed from Claude Code transcripts for measurement and diagnostics.

```ts
type RuntimeEvent = {
  id: string;
  projectId: string;
  taskId?: string;
  type:
    | "TASK_CREATED" | "TASK_CLAIMED" | "TASK_BLOCKED" | "RESULT_SUBMITTED"
    | "VERIFICATION_COMPLETED" | "REVIEW_SUBMITTED" | "REVIEW_RESPONDED"
    | "CONTEXT_REQUESTED" | "CONTEXT_FULFILLED" | "DECISION_RECORDED"
    | "LIMIT_EXCEEDED" | "TASK_ESCALATED" | "TASK_COMPLETED" | "TASK_FAILED"
    | "TASK_CANCELLED" | "GUARD_OVERRIDDEN" | "TOOL_CALLED";
  actor: "chatgpt" | "claude" | "human" | "hub";
  timestamp: string;
  payload: unknown;   // validated per type in packages/protocol
};
```

`TOOL_CALLED` records the endpoint, tool, request and response sizes, and estimated tokens for every MCP call. This is the raw data for §29.2.

---

## 25. Claude Code Integration

### 25.1 Adapter interface

```ts
interface CodingAgentAdapter {
  readonly kind: "pull" | "dispatch";
  // dispatch-capable adapters only (phase 2):
  startTask?(input: AgentTask): Promise<AgentRun>;
  getStatus?(runId: string): Promise<AgentRunStatus>;
  cancel?(runId: string): Promise<void>;
  // all adapters:
  collectUsage(session: AgentSessionRef): Promise<UsageReport>;
}
```

### 25.2 MVP: pull mode ([ADR-0005](../../docs/adr/0005-claude-pull-mode-first.md))

The developer's own Claude Code session connects to the local endpoint and calls `get_task` / `submit_result`. This mode:

- works with both a claude.ai subscription and an API key;
- works in the CLI and in VS Code;
- requires no automation of Claude Code.

ACR ships a **Claude Code plugin** containing:
- the MCP server entry for the local endpoint (`http://127.0.0.1:<local port>/mcp`, with the bearer token header);
- a Skill that explains the workflow (take a task, respect scope, use `run_tests`/`expand`, submit a structured result);
- a hook that reports the session's `session_id` and `transcript_path` to the hub when ACR tools are used, so usage can be attributed (§29.1). The hook inputs are to be re-verified (§38).

Until the plugin exists, `acr connect claude` prints the `claude mcp add` command (user scope, so the token never lands in the repository) and the PostToolUse hook entry (`acr hook`) to paste into Claude Code settings.

In pull mode the hub cannot enforce command policy inside Claude Code. It ships a recommended Claude Code permission settings snippet (§28.3) and verifies results after the fact (§21).

### 25.3 Phase 2: Agent SDK adapter (dispatch)

- `@anthropic-ai/claude-agent-sdk` runs Claude in-process, **with an API key only**. The SDK terms do not allow third-party products to use claude.ai login.
- `canUseTool` enforces the workspace boundary (§28.1) and command policy (§28.3) in code.
- `abortController` cancels a run. `maxTurns`/`maxBudgetUsd` enforce budgets. The result message provides complete usage.
- This adapter is what makes the Tier 1 benchmark (§30.2) possible.

### 25.4 Not supported

- Spawning `claude -p` on the user's subscription login. It is a terms grey area; revisit only if Anthropic clarifies.
- Channels (research preview, needs a dev flag, CLI-only).
- Controlling the VS Code UI.

---

## 26. ChatGPT Integration

- ChatGPT Web connects to the remote endpoint as a custom MCP connector in **Developer mode**. This is available to Plus, Pro, Business, Enterprise and Edu; on workspace plans an admin must allow it. Free and Go are not supported.
- Write tools trigger a confirmation in ChatGPT, which the user can remember per conversation. ACR keeps write tools few and read tools annotated (§14.1).
- Tool descriptions are the only prompt surface ACR controls on the ChatGPT side. They live in `packages/adapters/chatgpt`, which holds tool metadata and descriptions only. The hub core has no OpenAI-specific logic.
- No DOM scraping or browser automation ([ADR-0010](../../docs/adr/0010-no-ui-automation.md)).
- Later option: the ChatGPT desktop app in Work/Codex mode can use local stdio MCP without a tunnel. Because the core is transport-agnostic, adding a stdio transport for the remote tool set is cheap. It is not in MVP.

---

## 27. Remote Connectivity

```ts
interface RemoteBridge {
  readonly id: string;                           // e.g. "openai-secure-tunnel"
  readonly authenticatesCallers: boolean;
  expose(localEndpoint: string): Promise<RemoteEndpoint>;
  close(): Promise<void>;
}
```

### 27.1 First implementation: `openai-secure-tunnel`

This bridge wraps OpenAI's `tunnel-client`:

- `tunnel-client` makes only outbound HTTPS connections to OpenAI and forwards queued MCP requests to the local remote endpoint.
- Access is restricted to the tunnel's Platform organization / ChatGPT workspace and to users with *Tunnels Read + Use* permission.
- It needs an OpenAI runtime API key, read from the environment and never stored by ACR.

The bridge is enabled explicitly: `acr start --bridge openai-secure-tunnel`.

### 27.2 Authentication rule ([ADR-0004](../../docs/adr/0004-two-mcp-endpoints.md))

- MVP relies on the tunnel's org scoping as remote authentication. The hub does not run its own OAuth server in MVP.
- Any other bridge (cloudflared, ngrok, public HTTPS) MUST NOT be enabled until the hub's remote endpoint implements OAuth. Use CIMD, per MCP spec 2026-07-28.
- The **local endpoint is never passed to any bridge.** This is structural: the bridge receives only the remote endpoint's URL.

---

## 28. Security Model

Default posture: **deny by default.**

### 28.1 Workspace boundary

- Each task belongs to exactly one registered workspace root.
- Every hub file read (`read_file`, `get_diff`, artifacts) is resolved with `path.resolve` and must stay inside the root after resolving symlinks.
- There is a default deny-list: `.env*`, `**/*.pem`, `**/id_*`, `~/.ssh`, `~/.aws`, `~/.config/gcloud`, and any path outside the root.
- Configuration can extend the deny-list. It can never shrink the built-in part.

### 28.2 ChatGPT access

ChatGPT's access is limited to the scope in §14.2. There is no arbitrary file read and no shell on the remote endpoint.

### 28.3 Command policy

Command categories: `read_only`, `build`, `test`, `write`, `network`, `destructive`.

```yaml
command_policy:
  allow: [read_only, build, test]
  require_approval: [write, network, destructive]
```

- **MVP (pull mode):** delivered as a recommended Claude Code permission settings snippet plus the plugin Skill. Post-hoc verification (§21) catches out-of-scope changes.
- **Phase 2 (SDK):** enforced in `canUseTool`.

### 28.4 Secrets

Secrets never appear in task payloads, the decision ledger, context summaries, telemetry or logs. Redaction (legacy `privacy/redact`) covers:
- API keys;
- `Authorization` headers;
- bearer and OAuth tokens;
- private keys;
- `.env` values.

It is applied to everything leaving the hub on the remote endpoint and to all logs.

### 28.5 Audit

The RuntimeEvent log is the audit log. Destructive or guard-overriding actions require a human actor.

---

## 29. Telemetry and Metrics

All telemetry is local ([ADR-0006](../../docs/adr/0006-measured-vs-estimated-token-metrics.md)).

### 29.1 Claude side: measured

- **Source:** the Claude Code transcript of the session that worked on the task. It is located via the plugin hook (§25.2) and parsed by the legacy `claude-code` adapter, with usage de-duplicated by `requestId`.
- **Attribution:** requests between the task's `get_task` claim and its `submit_result`/`respond_review` calls in that session. A session may work on several tasks; boundaries come from the ACR tool calls in the transcript.
- **Known gap (important):** interactive-session transcripts do **not** include:
  - session title generation;
  - the permission classifier;
  - compaction calls.

  The only complete source seen so far is the headless `modelUsage` / `cost-state` entry, which is not available in interactive sessions. Pull-mode measurements are therefore reported as **`measured (lower bound, incomplete: <gaps>)`**. Complete measurement comes with the SDK adapter (§25.3).

### 29.2 ChatGPT side: estimated

The hub cannot see ChatGPT's system prompt, history, or token counts. It estimates **cumulative tool I/O**:

```text
for each remote tool call c in the task:
  size_c        = estimatedTokens(request_c) + estimatedTokens(response_c)
  persistence_c = number of later remote tool calls in the same task (lower bound on later turns)
chatgpt_tool_io_estimate = Σ size_c × (1 + persistence_c)
```

- **Tokenizer:** a fixed, versioned estimator (`packages/core/metrics/tokenize`). Its identity and version are stored with every estimate.
- **Label:** always shown as `estimated`.
- **Bound:** this is a **lower bound** on ChatGPT-side cost attributable to ACR tools. Turns without tool calls are invisible.

### 29.3 Reporting rules

- Measured and estimated numbers are reported **separately and never summed**.
- The headline metric per task is `{ claude_measured, chatgpt_estimated, quality }`.
- **Transferred context tokens** (inputs/outputs crossing agents) is a **secondary diagnostic** only, never a headline.

### 29.4 Diagnostics

The legacy rules R001–R004 run on each task's attributed transcript slice:
- repeated reads;
- repeated searches;
- environment-failure retries;
- re-reads after compaction.

They only produce advisory findings in `acr metrics` and are never enforced.

### 29.5 Tracked per task

Duration, Claude turns, review rounds, context requests, remote/local tool calls and their sizes, artifact expansions, test results, and verification findings.

---

## 30. Baseline and Benchmark

[ADR-0007](../../docs/adr/0007-two-tier-benchmark.md) defines the benchmark.

### 30.1 Baseline

The baseline is **the manual copy/paste workflow of §1**: the same assistants, where the developer pastes Claude's final message, full test output and full diff into ChatGPT, and pastes ChatGPT's review back.

The draft's "full-context handoff" baseline is dropped as a headline comparison. It overstates savings by construction.

### 30.2 Tier 1: automated, reproducible (phase 2)

- **ChatGPT stand-in:** an OpenAI API model given the same remote tool set and the same system instructions. **Claude:** the Agent SDK adapter.
- **Scripted baseline:** a harness reproduces the copy/paste workflow by passing Claude's full final message, full test output and full diff verbatim to the ChatGPT stand-in.
- **Optimized arm:** the ACR hub.
- **Tasks:** fixed task manifests with an external verifier the agents cannot modify, a train/holdout split, and repeated runs.
- **Statistics:** the legacy paired gates in `packages/benchmark` (Tango score lower bound for success rate, task-cluster bootstrap for tokens) with a fixed `stats_plan`.
- **Outcomes:** `regressed` / `no_gain` / `inconclusive` / `validated_for_scope`.
- The runner is an opt-in edge component (paid API calls, explicit budget).

Benchmark task categories: doc fix, simple bug, API feature, refactor, auth change, cross-module change.

### 30.3 Tier 2: manual pilot (MVP)

A small number of real tasks run by the developer in ChatGPT Web, recorded with `acr metrics` and a pilot template (legacy `docs/pilot.md` adapted). This is **supporting evidence only**. It is not used for any savings claim.

### 30.4 Claims rule

README and any public claim may cite **only Tier 1 results with outcome `validated_for_scope`**, stating their scope (models, host versions, task set). A token optimization is never accepted because output "looks smaller".

---

## 31. Human Control

The developer can, via CLI (and via ChatGPT where a remote tool exists):
- approve, pause or cancel a task;
- request or skip review;
- inspect context bundles, decisions and events;
- override guards (recorded);
- resolve ESCALATED tasks;
- approve destructive actions.

---

## 32. CLI

```text
acr init                         # register workspace, create .agent-runtime/config.json
acr start [--bridge openai-secure-tunnel] [--port N]
acr status
acr task list | show <id> | accept <id> [--force] | cancel <id> | resolve <id>
acr context show <id>            # the bundle each side would receive now
acr decisions list
acr metrics <id>                 # measured / estimated / diagnostics
acr export [<id>]
acr plugin install               # install the Claude Code plugin / print .mcp.json snippet

# legacy, retained
acr test | expand | analyze | compare | prune | policies | adapters
```

Example:

```text
$ acr status
Project:          demo-api
Hub:              running (127.0.0.1:8787)
Remote bridge:    openai-secure-tunnel (connected)
Claude session:   seen 2m ago (pull mode)
Active task:      T-21  Implement OAuth token validation  [IMPLEMENTED, risk: high]
Verification:     ok (3 files, 38 tests verified)
Next:             High risk: ask ChatGPT to review T-21 before accepting.
Tokens:           Claude measured ≥ 41,280 (incomplete: ai-title)
                  ChatGPT tool I/O ≈ 3,910 (estimated, lower bound)
```

---

## 33. Monorepo Structure

```text
agent-collaboration-runtime/
├── apps/
│   └── cli/                 # `acr`: hub commands (init/start/status/task/…) + legacy commands
├── packages/
│   ├── protocol/            # zod: Task, Result, Review, Decision, RuntimeEvent, TranscriptEvent
│   ├── storage/             # SqlDatabase interface + node:sqlite implementation + HubStore + migrations
│   ├── core/                # offline hub domain
│   │   ├── hub.ts           # business operations behind every tool (suggest + refuse)
│   │   ├── config.ts        # .agent-runtime/config.json schema and defaults
│   │   ├── artifacts.ts     # hub artifact store (hash-checked, range reads, redaction)
│   │   ├── task/            # state machine, risk rules
│   │   ├── context/         # Context Broker
│   │   ├── verify/          # result verification (GitReader injected)
│   │   └── metrics/         # attribution, measured vs estimated
│   ├── compression/         # legacy Jest result view
│   ├── artifacts/           # legacy test-run artifact store, expand, prune
│   ├── security/            # redaction, workspace boundary, deny-list
│   ├── transcripts/         # legacy transcript adapters (claude-code, canonical) + usage normalisation
│   ├── telemetry/           # legacy R001–R004 diagnostics + analysis report
│   ├── benchmark/           # legacy evaluate: manifests, Tango, bootstrap, gates
│   ├── platform/            # app-data dir, token estimator, version, report writing
│   ├── runner/              # (edge) legacy Jest runner + policies + integrity gate
│   ├── git/                 # (edge) read-only git reader
│   ├── mcp/                 # (edge) the hub process: both endpoints, workspace setup, run_tests wiring
│   ├── claude-sdk/          # (phase 2, edge)
│   └── remote-bridge/       # (phase 3, edge) RemoteBridge + openai-secure-tunnel
├── integrations/claude-code/   # Skill today; the Claude Code plugin later
├── fixtures/                # real + synthetic (legacy, unchanged)
├── examples/
├── scripts/                 # build, core import check, fixture capture, de-identification
├── docs/                    # zh-TW user docs; docs/adr/ in English
├── CONTEXT.md
└── Document/plan/           # SPEC, feasibility, archive
```

Workspace packages export `acr-source` (TypeScript, used by typecheck and tests) and `default` (built JS) conditions; `scripts/build.mjs` builds them in dependency order without needing `pnpm` on PATH. ChatGPT tool metadata and descriptions live in `packages/mcp/src/tools.ts` rather than a separate adapters package, since the MCP wiring is the only consumer.

Git access in `core/verify` is injected through an interface, so the core stays offline and testable. `packages/git` supplies the real (read-only, argv-only) implementation.

---

## 34. Testing Strategy

### 34.1 Unit tests (core, offline, no external tools)

- protocol validation;
- state machine transitions and guards;
- context ranking and inline/reference thresholds;
- token estimator;
- limits;
- risk path rules;
- verification logic with fake git;
- workspace boundary and deny-list (including Windows paths, symlinks, `..`);
- redaction;
- telemetry attribution on transcript fixtures;
- all legacy tests (moved, must stay green).

### 34.2 Integration tests

- MCP contract tests for both endpoints: the tool list, `readOnlyHint` values, and that the local tools are **absent** from the remote endpoint;
- the end-to-end flow of §13 with a **FakeClaude** that calls local tools and a **FakeChatGPT** that calls remote tools;
- SQLite persistence and restart recovery (state rebuilt from events);
- `run_tests` against real Jest fixtures;
- verification against a real temporary git repository.

### 34.3 Cross-platform

**CI matrix:** `macos-latest`, `windows-latest`, `ubuntu-latest` × Node **24** and **26**. Tests must not silently skip Windows.

| Platform | Specific cases |
|---|---|
| Windows | Drive letters, backslashes, spaces in paths, PowerShell env, process spawn, SQLite locking, Ctrl+C shutdown |
| macOS | Spaces in `~/Library` paths, Apple Silicon, file permissions |
| Linux | XDG paths, headless, permissions |

Core tests run with network disabled where the CI runner allows it. The §9.3 import check runs in CI.

---

## 35. Delivery Plan

### Phase 0 — Migration

1. Tag the current state (`v0-agent-efficiency`).
2. Create the pnpm workspace per §33 and move the legacy modules per §10.
3. Rename the package and CLI to `acr` (legacy commands kept).
4. Raise Node to 24.
5. Add the CI matrix and the §9.3 import check.

**Exit:** every legacy test is green on all three OSes.

### Phase 1 — Core

protocol, storage (`node:sqlite`), RuntimeEvent log, state machine + guards, limits, token estimator, Context Broker, verification (fake git), CLI `init/status/task/context/decisions`.

**Exit:** the §13 flow runs in unit/integration tests with fakes, offline.

### Phase 2 — Hub and Claude side

Daemon, MCP wiring, local endpoint tools, `run_tests`/`expand` via legacy runner and artifacts, real git verification, the Claude Code plugin (MCP entry, Skill, hook), transcript attribution.

**Exit:** a real Claude Code session (CLI and VS Code) completes a task pulled from the hub.

### Phase 3 — ChatGPT side

Remote endpoint tools, scoped file access, the `openai-secure-tunnel` bridge, tool descriptions.

**Exit:** ChatGPT Web creates a task, reads the result, and accepts it through the tunnel.

### Phase 4 — Review and decisions

Review rounds, `respond_review`, `request_context`/`fulfill_context`, decision ledger, completion guards, escalation.

### Phase 5 — Metrics and Tier 2 pilot

`acr metrics`, R001–R004 on task slices, the pilot template, and a Tier 2 pilot of at least 5 real tasks.

**MVP is done at the end of Phase 5.**

### After MVP

- **Phase 6:** Agent SDK adapter, budgets, Tier 1 benchmark.
- **Later:** context cache (with a reliable signal), automatic risk classification, a full Token Governor, more test runners, OAuth plus other bridges, a desktop stdio transport, and other agents (Codex, Gemini, OpenCode). These come only after the protocol is stable.

---

## 36. First End-to-End Demo

This is the flow of §13 with "Add a health-check endpoint to this service" on the example service:

1. ChatGPT creates the task with scope and acceptance criteria.
2. Claude pulls it, implements it, runs tests through `run_tests`, and submits.
3. The hub verifies the result.
4. ChatGPT receives only the summary, changed files, verified test counts, uncertainties, verification findings and token metrics.
5. With no concern, ChatGPT accepts. With a concern, it reads the exact diff range and submits a review.

---

## 37. MVP Success Criteria

1. ChatGPT Web creates a structured task through the tunnel. No DOM scraping is involved.
2. A Claude Code session (CLI **and** VS Code) pulls and executes it and returns a structured result.
3. The hub verifies the result against git and test artifacts, and ChatGPT sees the findings.
4. ChatGPT requests focused additional context (file range, artifact range, or `request_context`), and receives it.
5. A review round with `changes_requested` → `respond_review` → accept completes.
6. Task, decision, review and event history persists across hub restarts.
7. Claude-side tokens are attributed per task (labelled lower bound). ChatGPT-side tool I/O is estimated and labelled.
8. Local tools are provably absent from the remote endpoint (contract test).
9. The same runtime passes CI on macOS, Windows and Linux (Node 24, 26).
10. A Tier 2 pilot report exists. **No savings percentage is claimed in MVP.**

---

## 38. Open Questions — Re-verify Before Dependent Work

| # | Question | Blocks |
|---|---|---|
| 1 | Is ChatGPT Developer mode GA or beta for personal Plus/Pro? (Sources conflicted on 2026-09-29.) | Phase 3 |
| 2 | `tunnel-client` platform support (Windows/Linux/macOS binaries) and any per-tool exposure controls | Phase 3 |
| 3 | ~~Does the official MCP TypeScript SDK support the 2026-07-28 revision?~~ **Answered 2026-09-30: no.** SDK 1.31.0 (latest) speaks up to 2025-11-25. The hub uses it in stateless mode, which is compatible with Claude Code today. Still open: does ChatGPT Developer mode accept it? | Phase 3 |
| 4 | Claude Code hook inputs (`session_id`, `transcript_path`) and whether plugin hooks fire in the VS Code extension | Phase 2 |
| 5 | Does any interactive-session source include title-generation / classifier / compaction usage? | Phase 5 (upgrades "lower bound") |
| 6 | `node:sqlite` on Node 24.20: WAL with the hub and CLI open concurrently worked in the demo, and no ExperimentalWarning was printed. Windows and Linux are not yet verified (needs the CI run). | CI |
| 7 | Could Anthropic's terms ever allow a local tool to spawn `claude -p` on the user's own subscription? | Revisit only |

---

## 39. Architectural Rule

Keep this visible in the codebase (root README and `packages/core` README):

> **Agents do not share conversations. They share evidence, tasks, decisions, and only the context necessary for the next action.**

---

## 40. Product Differentiation

ACR is **not** primarily an agent launcher, chat room, dashboard, shared-memory service, or Claude↔ChatGPT bridge.

It differentiates on:
- token-aware collaboration measured honestly (measured vs estimated);
- minimum necessary context via compact results and artifact references;
- structured handoff;
- hub-verified evidence;
- deterministic limits;
- quality-gated benchmarking;
- a cross-platform, local-first runtime.

---

## 41. Development Rules for Claude Code

When implementing this repository:

1. Follow this SPEC unless an ADR in `docs/adr/` supersedes it. Record new architectural decisions there (short format: context, decision, why).
2. No new infrastructure without clear need.
3. Deterministic logic before LLM-based logic.
4. Provider-specific code only in `packages/adapters/*` and `packages/remote-bridge`.
5. Core packages stay offline (§9). Never bypass the import check.
6. Every filesystem operation is cross-platform. Every process path is tested on Windows.
7. No Bash scripts for core workflows. No DOM scraping. No arbitrary remote shell.
8. Tests with every core feature. Legacy tests must stay green.
9. Protocol payloads are versioned. No undocumented protocol changes.
10. Never report estimated tokens as measured. Never sum the two.
11. Never claim an optimization succeeded if quality regressed or the result is `inconclusive`.

## 42. Definition of Done

A feature is done when:
- the implementation is complete and tests pass;
- it is Windows-, macOS- and Linux-compatible (CI);
- it causes no undocumented protocol change and no security-boundary regression;
- the core stays offline;
- telemetry is added where relevant;
- the docs are updated (zh-TW user docs; ADR if a decision was made).

## 43. ADR Index

| ADR | Decision |
|---|---|
| [0001](../../docs/adr/0001-monorepo-reusing-legacy-modules.md) | Monorepo that moves the legacy modules instead of rewriting them |
| [0002](../../docs/adr/0002-layered-offline-core.md) | Offline core, opt-in edges |
| [0003](../../docs/adr/0003-human-driven-hub.md) | The hub is a human-driven mailbox and gatekeeper, not an orchestrator |
| [0004](../../docs/adr/0004-two-mcp-endpoints.md) | Separate remote and local MCP endpoints; tunnel org scoping as MVP auth |
| [0005](../../docs/adr/0005-claude-pull-mode-first.md) | Claude pull mode first; SDK second; no `claude -p` on subscription |
| [0006](../../docs/adr/0006-measured-vs-estimated-token-metrics.md) | Headline metric: measured Claude vs estimated ChatGPT, never summed; copy/paste baseline |
| [0007](../../docs/adr/0007-two-tier-benchmark.md) | Two-tier benchmark; only Tier 1 may support claims |
| [0008](../../docs/adr/0008-node-sqlite-node24.md) | `node:sqlite` on Node 24+ behind a storage interface |
| [0009](../../docs/adr/0009-scoped-read-access-for-chatgpt.md) | ChatGPT reads only task-scoped files; hub computes the diff |
| [0010](../../docs/adr/0010-no-ui-automation.md) | No DOM scraping or UI automation |

---

## 44. Final Product Principle

Prefer:
- less conversation, more structure;
- less duplicated context, more references;
- less model agreement theater, more evidence;
- less agent activity, more task completion;
- fewer claims, more measurement.

The product succeeds when the developer feels that ChatGPT and Claude Code cooperate like a disciplined engineering team, without paying the token cost of making every agent know everything, and when that feeling is backed by numbers that survive scrutiny.
