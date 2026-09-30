# Agent Collaboration Runtime — SPEC.md

> Cross-platform, token-efficient collaboration runtime for **ChatGPT Web + Claude Code (CLI / VS Code)**.
>
> Primary development environment: **macOS**
>
> Required runtime support: **macOS / Windows / Linux**

---

## 0. Project Summary

This project is a **token-efficient collaboration runtime for AI coding agents**.

The first supported collaboration pair is:

- **ChatGPT Web** — Architect / Reviewer / Human-facing collaboration surface
- **Claude Code** — Implementer / Executor running locally through CLI or VS Code

The goal is **not** merely to let two AI tools exchange messages.

The goal is to make them behave more like an engineering team:

- split responsibilities,
- hand off tasks,
- challenge assumptions,
- request evidence,
- review work,
- preserve decisions,
- share only the minimum necessary context,
- stop unnecessary conversations,
- and reduce total token usage without reducing correctness or completion quality.

Core principle:

> **Same or better task quality with less cross-agent context and fewer tokens.**

---

# 1. Problem Statement

Today, developers can use ChatGPT and Claude Code separately, but collaboration between them is mostly manual.

Typical workflow:

1. Discuss architecture in ChatGPT.
2. Copy requirements into Claude Code.
3. Claude Code reads the repository and implements changes.
4. Copy Claude's result back into ChatGPT.
5. Ask ChatGPT to review.
6. Copy review comments back into Claude.
7. Repeat.

This has several problems:

- duplicated context,
- repeated explanations,
- excessive token usage,
- lost decisions,
- weak traceability,
- unclear ownership,
- unnecessary review cycles,
- large context windows copied between agents,
- inconsistent task handoffs,
- platform-specific scripts,
- fragile browser automation.

This project introduces a **Collaboration Hub** between ChatGPT Web and Claude Code.

---

# 2. Product Vision

The long-term vision is:

```text
                    Human
                      │
                      ▼
               ChatGPT Web
         Architect / Reviewer
                      │
              MCP-compatible
                 interface
                      │
                      ▼
        ┌─────────────────────────┐
        │   Collaboration Hub     │
        │                         │
        │ Task Graph              │
        │ Context Broker          │
        │ Token Governor          │
        │ Decision Ledger         │
        │ Conflict Resolver       │
        │ Agent Router            │
        │ Telemetry               │
        └────────────┬────────────┘
                     │
              Local Adapter
                     │
                     ▼
               Claude Code
            CLI / VS Code
              Implementer
                     │
                     ▼
                 Repository
```

The Collaboration Hub decides:

- who needs to act,
- what context is necessary,
- whether review is required,
- what evidence should be returned,
- when disagreement needs escalation,
- when another round is unnecessary,
- and when the task is complete.

---

# 3. Primary Goal

The primary engineering objective is:

> **Reduce total token usage across multi-agent coding tasks without reducing correctness, completion quality, or developer control.**

Optimization target:

```text
Quality
  ↑
  │                  ● Target
  │
  │        ● Multi-agent baseline
  │
  │  ● Solo agent
  │
  └──────────────────────────────→ Token usage
```

We are not optimizing for the smallest possible prompt.

We are optimizing for:

```text
quality / token
```

---

# 4. Non-Goals

The MVP MUST NOT attempt to:

- replace Claude Code,
- replace ChatGPT,
- build a new coding model,
- create a general-purpose agent framework,
- scrape the ChatGPT DOM,
- automate browser clicks as the primary integration method,
- synchronize every conversation message,
- share full agent context by default,
- implement autonomous multi-agent debates,
- require Docker to run,
- require Redis, Kafka, PostgreSQL, or other infrastructure,
- assume a POSIX shell,
- depend on macOS-only APIs.

---

# 5. Supported Platforms

## Required

The runtime MUST support:

- macOS
- Windows 11
- mainstream Linux distributions

macOS is the primary development environment, but no architectural decision may make Windows or Linux secondary-class platforms.

---

# 6. Cross-Platform Rules

These are hard requirements.

## 6.1 File Paths

Never build paths manually.

Forbidden:

```ts
const path = root + "/.agent-runtime/tasks/" + taskId;
```

Required:

```ts
import path from "node:path";

const taskPath = path.join(root, ".agent-runtime", "tasks", taskId);
```

Always support:

```text
macOS/Linux:
/Users/lily/project
/home/user/project

Windows:
C:\Users\Lily\project
```

---

## 6.2 Shell Commands

Do not assume Bash exists.

Forbidden:

```ts
spawn("bash", ["-c", command]);
```

Do not put core logic into:

```text
.sh
.zsh
```

Prefer:

```ts
spawn(command, args, {
  shell: false
});
```

If shell execution is unavoidable, implement an OS abstraction.

```text
src/platform/
├── process.ts
├── filesystem.ts
├── environment.ts
└── shell.ts
```

---

## 6.3 Environment Variables

Use:

```ts
process.env
```

Never depend on:

```text
export FOO=bar
```

Documentation must include:

### macOS / Linux

```bash
export ACR_PORT=8787
```

### Windows PowerShell

```powershell
$env:ACR_PORT="8787"
```

---

## 6.4 Process Management

Do not rely only on Unix signals such as:

```text
SIGUSR1
SIGUSR2
```

Graceful shutdown may use supported signals when available, but core coordination must work without Unix-only IPC.

Preferred IPC:

- localhost HTTP
- WebSocket
- stdio
- local files
- SQLite

---

## 6.5 File Locking

Do not assume POSIX `flock`.

SQLite should be the primary transactional coordination mechanism.

---

## 6.6 Networking

Default local bind:

```text
127.0.0.1
```

Do not expose the local service publicly unless explicitly configured.

---

## 6.7 Executable Resolution

Do not hard-code:

```text
/usr/local/bin/claude
```

Use PATH lookup.

Examples:

```text
claude
claude.exe
```

Provide a configurable executable path.

---

# 7. Technology Stack

## MVP Recommended Stack

### Runtime

- Node.js 22+
- TypeScript
- pnpm

Reasons:

- native cross-platform support,
- strong process / filesystem APIs,
- easy CLI development,
- easy MCP integration,
- good fit for Claude Code ecosystem,
- fast MVP development.

---

## Core Libraries

Prefer minimal dependencies.

Suggested categories:

```text
CLI            commander or citty
Validation     zod
Database       better-sqlite3 OR sqlite equivalent
HTTP           Fastify
WebSocket      ws
Logging        pino
Testing        Vitest
Build          tsup
```

Do not introduce NestJS for the MVP unless complexity clearly requires it.

The runtime should remain lightweight.

---

# 8. Project Working Name

Temporary name:

```text
ACR
Agent Collaboration Runtime
```

Naming must remain replaceable.

Do not hard-code product branding into protocol fields.

---

# 9. MVP Scope

MVP supports exactly two roles.

```text
ChatGPT Web
    │
    │ Architect / Reviewer
    │
    ▼
Collaboration Hub
    ▲
    │ Implementer
    │
Claude Code
```

Do not add Codex, Gemini, or other agents until the core protocol is stable.

---

# 10. MVP Capabilities

The MVP MUST implement:

1. Task Handoff
2. Structured Result
3. Context Broker
4. Review on Demand
5. Token / Context Telemetry
6. Decision Ledger
7. Cross-platform local daemon
8. Claude Code adapter
9. ChatGPT-facing MCP-compatible interface
10. Benchmark mode

---

# 11. Core Design Principle — Minimum Necessary Context

Agents MUST NOT receive all available context by default.

Every context transfer should answer:

```text
Why does this agent need this information?
```

Context categories:

```text
requirement
constraint
architecture
source
diff
test
runtime_error
decision
uncertainty
review_comment
```

Each context item MUST carry:

```ts
type ContextItem = {
  id: string;
  taskId: string;
  type: ContextType;
  source: string;
  content: string;
  estimatedTokens: number;
  priority: "critical" | "high" | "normal" | "low";
  expiresAt?: string;
};
```

---

# 12. Agent Roles

## ChatGPT

Default responsibilities:

```text
Architect
Reviewer
Requirement clarifier
Decision maker with human
Risk reviewer
```

ChatGPT should normally receive:

- requirements,
- architecture decisions,
- summaries,
- diffs when needed,
- tests,
- uncertainties,
- evidence requested during review.

ChatGPT should NOT automatically receive:

- full repository,
- all file reads,
- full Claude transcript,
- all shell output,
- every tool call.

---

## Claude Code

Default responsibilities:

```text
Repository inspection
Implementation
Refactoring
Testing
Local debugging
Evidence collection
```

Claude should normally receive:

- task goal,
- target scope,
- constraints,
- acceptance criteria,
- relevant decisions,
- requested files if already identified.

Claude should NOT automatically receive:

- entire ChatGPT conversation,
- unrelated historical discussions,
- previous brainstorming that has no effect on implementation.

---

# 13. Task Protocol

Task handoff MUST use structured data.

Example:

```yaml
version: 1

task:
  id: AUTH-21
  title: Implement OAuth token validation
  type: implementation

goal:
  Implement OAuth token validation middleware.

scope:
  paths:
    - src/auth/
    - src/config/auth.ts

constraints:
  - Preserve existing session login.
  - Do not change database schema.
  - Do not modify unrelated modules.

acceptance:
  - Existing auth tests pass.
  - New OAuth validation tests pass.
  - Legacy session fallback still works.

context_refs:
  - CTX-101
  - DEC-009

review_policy:
  required: true
  reason: authentication_change
```

---

# 14. Result Protocol

Claude MUST return a compact structured result.

Example:

```yaml
version: 1

result:
  task_id: AUTH-21
  status: completed

changes:
  - path: src/auth/oauth.ts
    summary: Added access-token validation.

  - path: src/auth/middleware.ts
    summary: Integrated OAuth middleware with legacy session fallback.

tests:
  passed: 38
  failed: 0

decisions:
  - OAuth validation runs before legacy cookie fallback.

uncertainties:
  - Refresh-token rotation is not implemented.

review:
  recommended: true
  focus:
    - refresh-token lifecycle

evidence:
  - src/auth/oauth.ts:41-109
  - src/auth/middleware.ts:90-138
```

Do not return full tool history.

---

# 15. Challenge Protocol

Agent disagreement should be structured.

Example:

```yaml
challenge:
  id: CH-12
  task_id: AUTH-21

claim:
  "OAuth migration is backward compatible."

reason:
  "Legacy cookie fallback appears to be removed."

severity: high

evidence:
  - src/auth/middleware.ts:118

requested_action:
  inspect_and_respond
```

Claude response:

```yaml
challenge_response:
  challenge_id: CH-12

accepted: true

action:
  restored_legacy_cookie_fallback

evidence:
  - src/auth/middleware.ts:121-146
  - test/auth/session.test.ts
```

Avoid free-form debate unless escalation is explicitly required.

---

# 16. Communication Rules

The system MUST discourage unnecessary agent chatter.

Forbidden default pattern:

```text
Agent A:
I think...

Agent B:
Good point...

Agent A:
Thanks, I agree...

Agent B:
Let's proceed...
```

Preferred:

```text
claim
evidence
challenge
response
decision
```

---

# 17. Context Broker

The Context Broker is a central component.

Responsibilities:

```text
select context
rank context
truncate context
deduplicate context
estimate token cost
track provenance
request missing context
expire stale context
```

Interface:

```ts
interface ContextBroker {
  buildContext(request: ContextRequest): Promise<ContextBundle>;
}
```

Example request:

```ts
type ContextRequest = {
  taskId: string;
  agent: "chatgpt" | "claude";
  purpose:
    | "implement"
    | "review"
    | "debug"
    | "plan"
    | "challenge";
  tokenBudget?: number;
  requiredTypes?: ContextType[];
};
```

---

# 18. Token Governor

The Token Governor determines whether additional context or another agent turn is worth the cost.

Inputs:

```text
task complexity
risk
uncertainty
current evidence
review status
context size
previous failures
remaining token budget
```

Possible decisions:

```text
CONTINUE
REQUEST_CONTEXT
REQUEST_REVIEW
SKIP_REVIEW
ESCALATE
STOP
```

---

# 19. Review Policy

Reviews MUST NOT happen automatically for every task.

Suggested policy:

## Low risk

Examples:

- typo,
- documentation,
- simple rename,
- formatting.

Mode:

```text
Claude only
```

---

## Medium risk

Examples:

- feature implementation,
- cache integration,
- API changes.

Mode:

```text
ChatGPT plan
→ Claude implementation
```

Review may be optional.

---

## High risk

Examples:

- authentication,
- authorization,
- payment,
- database migration,
- destructive operations,
- public API breaking changes.

Mode:

```text
ChatGPT plan
→ Claude implementation
→ ChatGPT review
→ Claude response if needed
```

---

# 20. Decision Ledger

Important engineering decisions must be stored separately from conversation history.

Example:

```yaml
decision:
  id: DEC-009
  task_id: AUTH-21
  title: Preserve legacy cookie fallback

status: accepted

reason:
  OAuth migration must remain backward compatible.

evidence:
  - existing session tests

created_by: chatgpt
created_at: 2026-09-29T10:00:00+08:00
```

The Decision Ledger prevents repeated reasoning.

---

# 21. Storage

MVP storage:

```text
SQLite
```

Why:

- local-first,
- no service dependency,
- transactional,
- cross-platform,
- inspectable,
- portable.

Suggested tables:

```text
projects
tasks
task_events
context_items
decisions
challenges
reviews
agent_runs
token_usage
artifacts
```

---

# 22. Local Project Directory

Each repository may contain:

```text
.agent-runtime/
├── config.json
├── cache/
├── logs/
└── exports/
```

Do not store authoritative state only in these files.

SQLite is authoritative.

The local directory is for configuration, cache, logs, and export.

---

# 23. Global Configuration

Cross-platform config location should use OS-standard application directories.

Example abstraction:

```ts
getAppDataDirectory()
```

Possible platform paths:

```text
macOS:
~/Library/Application Support/agent-collaboration-runtime/

Windows:
%APPDATA%\agent-collaboration-runtime\

Linux:
~/.config/agent-collaboration-runtime/
```

Use a library or platform abstraction.

Do not manually derive these paths in many places.

---

# 24. Claude Code Integration

Claude Code integration MUST be isolated behind an adapter.

```ts
interface CodingAgentAdapter {
  startTask(input: AgentTask): Promise<AgentRun>;
  getStatus(runId: string): Promise<AgentRunStatus>;
  cancel(runId: string): Promise<void>;
}
```

Initial implementation:

```text
ClaudeCodeAdapter
```

Support:

```text
CLI
VS Code workflow through shared local runtime
```

The runtime must not depend on controlling the VS Code UI.

VS Code should be treated as another interface to Claude Code, not as an automation target.

---

# 25. ChatGPT Integration

Do not use DOM scraping as the primary integration.

Preferred architecture:

```text
ChatGPT Web
    │
    │ MCP-compatible remote interface
    ▼
Collaboration Hub
```

Provider-specific implementation must live behind:

```text
src/adapters/chatgpt/
```

The core runtime must not depend on OpenAI-specific protocol details.

---

# 26. Remote-to-Local Connectivity

ChatGPT Web cannot assume direct access to localhost.

Therefore the architecture must support:

```text
ChatGPT Web
    │
    ▼
Remote HTTPS Bridge
    │
 authenticated tunnel
    ▼
Local Collaboration Hub
```

For development, the transport may use a secure tunnel provider.

However:

- tunnel provider must be replaceable,
- core runtime must not depend on one vendor,
- no repository data is exposed unless requested,
- all remote calls require authentication.

Define:

```ts
interface RemoteBridge {
  expose(localEndpoint: string): Promise<RemoteEndpoint>;
  close(): Promise<void>;
}
```

---

# 27. Security Model

Default posture:

```text
deny by default
```

The runtime MUST implement:

- workspace root restrictions,
- path traversal protection,
- command allow/deny policy,
- remote authentication,
- task-scoped permissions,
- audit logs,
- explicit destructive action confirmation,
- secrets redaction,
- no arbitrary remote shell by default.

---

# 28. Workspace Boundary

Each task must be attached to exactly one workspace.

Example:

```json
{
  "workspaceRoot": "/Users/lily/projects/demo"
}
```

An agent must not read:

```text
../other-project
~/.ssh
~/.aws
system secrets
```

unless explicitly configured.

---

# 29. Command Policy

Commands should be categorized:

```text
read_only
build
test
write
network
destructive
```

Example:

```yaml
command_policy:

  allow:
    - read_only
    - build
    - test

  require_approval:
    - network
    - destructive
```

---

# 30. Secrets

Never place secrets in:

```text
task payload
decision ledger
context summaries
telemetry
logs
```

Implement basic redaction for:

```text
API keys
Authorization headers
tokens
private keys
.env values
```

---

# 31. Telemetry

Telemetry must be local-first.

Track:

```text
task duration
agent turns
context bytes
estimated input tokens
estimated output tokens
context items transferred
review count
challenge count
rework count
tests passed
task result
```

---

# 32. Token Savings Metric

For every task calculate:

```text
baseline_context_tokens
actual_context_tokens
saved_tokens
saving_percentage
```

Example:

```text
Baseline shared context: 18,420 tokens
Actual transferred:       3,210 tokens
Saved:                   15,210 tokens
Reduction:                 82.6%
```

This metric is a core product feature.

---

# 33. Baseline Definition

MVP baseline:

> Full-context handoff.

For benchmarking:

```text
Baseline:
ChatGPT handoff includes all available project/task conversation context.

Optimized:
Context Broker selects minimum necessary context.
```

Later baselines may include:

```text
manual copy/paste
full transcript sharing
multi-agent unrestricted conversation
```

---

# 34. Quality Metrics

Token reduction is meaningless if task quality drops.

Every benchmark must record:

```text
task completed
tests passed
acceptance criteria passed
human correction required
review defects
rework rounds
```

Primary metric:

```text
token reduction at equal-or-better quality
```

---

# 35. Benchmark Harness

Create:

```text
packages/benchmark/
```

Benchmark task categories:

```text
01-doc-fix
02-simple-bug
03-api-feature
04-refactor
05-auth-change
06-cross-module-change
```

For each benchmark:

```text
baseline run
optimized run
```

Output:

```json
{
  "task": "03-api-feature",
  "baselineTokens": 15420,
  "optimizedTokens": 6710,
  "reduction": 0.5648,
  "baselinePassed": true,
  "optimizedPassed": true
}
```

---

# 36. Stop Conditions

The runtime MUST prevent infinite collaboration loops.

Default limits:

```text
max_agent_turns = 8
max_review_rounds = 2
max_challenge_rounds = 2
```

Stop when:

```text
acceptance criteria satisfied
AND tests pass
AND no unresolved high-severity challenge
```

Escalate to human when:

```text
repeated failure
conflicting requirements
security-sensitive uncertainty
budget exceeded
agent disagreement unresolved
```

---

# 37. Human Control

The developer remains in control.

Human actions:

```text
approve task
pause task
cancel task
request review
skip review
inspect context
inspect decisions
override routing
approve destructive action
```

---

# 38. CLI

Proposed commands:

```text
acr init

acr start

acr status

acr task list

acr task show AUTH-21

acr task run AUTH-21

acr task cancel AUTH-21

acr context show AUTH-21

acr decisions list

acr review request AUTH-21

acr metrics AUTH-21

acr benchmark run
```

---

# 39. Example CLI Output

```text
$ acr status

Agent Collaboration Runtime

Project:
  demo-api

Runtime:
  running

Claude Code:
  connected

ChatGPT bridge:
  connected

Active task:
  AUTH-21
  Implement OAuth token validation

Phase:
  implementation

Context:
  2,840 estimated tokens

Baseline:
  11,420 estimated tokens

Saved:
  75.1%
```

---

# 40. Proposed Monorepo Structure

```text
agent-collaboration-runtime/

├── apps/
│   ├── cli/
│   └── daemon/
│
├── packages/
│   ├── core/
│   │   ├── task/
│   │   ├── context/
│   │   ├── routing/
│   │   ├── review/
│   │   ├── decision/
│   │   └── telemetry/
│   │
│   ├── protocol/
│   │
│   ├── storage/
│   │
│   ├── security/
│   │
│   ├── platform/
│   │
│   ├── adapters/
│   │   ├── claude-code/
│   │   └── chatgpt/
│   │
│   ├── remote-bridge/
│   │
│   └── benchmark/
│
├── examples/
│
├── docs/
│
├── tests/
│   ├── integration/
│   └── cross-platform/
│
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
└── README.md
```

---

# 41. Protocol Package

All agent communication schemas MUST live in:

```text
packages/protocol
```

Use Zod schemas.

Example:

```ts
export const TaskSchema = z.object({
  version: z.literal(1),
  task: z.object({
    id: z.string(),
    title: z.string(),
    type: z.enum([
      "implementation",
      "bugfix",
      "refactor",
      "review",
      "investigation"
    ])
  })
});
```

Do not let adapters invent their own payload formats.

---

# 42. Event Model

Use an append-style event log.

Example events:

```text
TASK_CREATED
TASK_ASSIGNED
CONTEXT_ATTACHED
AGENT_STARTED
AGENT_COMPLETED
REVIEW_REQUESTED
CHALLENGE_CREATED
CHALLENGE_RESOLVED
DECISION_RECORDED
TASK_COMPLETED
TASK_FAILED
```

Event:

```ts
type RuntimeEvent = {
  id: string;
  taskId: string;
  type: RuntimeEventType;
  actor: string;
  timestamp: string;
  payload: unknown;
};
```

This makes debugging and future replay possible.

---

# 43. Task State Machine

Initial state machine:

```text
CREATED
  │
  ▼
PLANNED
  │
  ▼
READY
  │
  ▼
RUNNING
  │
  ├──────► BLOCKED
  │
  ▼
IMPLEMENTED
  │
  ├──────► REVIEWING
  │           │
  │           ├────► CHANGES_REQUESTED
  │           │          │
  │           └──────────┘
  │
  ▼
COMPLETED
```

Terminal states:

```text
COMPLETED
FAILED
CANCELLED
```

---

# 44. Routing

The MVP does not need machine-learning routing.

Use deterministic rules first.

Example:

```ts
if (task.risk === "low") {
  return ["claude"];
}

if (task.risk === "medium") {
  return ["chatgpt-plan", "claude"];
}

if (task.risk === "high") {
  return [
    "chatgpt-plan",
    "claude",
    "chatgpt-review"
  ];
}
```

Routing must be replaceable later.

---

# 45. Risk Classification

Initial heuristic:

## Low

```text
docs
comments
formatting
rename
small isolated fix
```

## Medium

```text
feature
API behavior
cache
cross-file refactor
```

## High

```text
auth
authorization
payment
database migration
data deletion
secrets
public breaking API
```

---

# 46. Context Priority

When token budget is limited:

```text
1. task goal
2. constraints
3. acceptance criteria
4. active decisions
5. exact relevant source
6. failing tests/errors
7. relevant diff
8. historical context
```

Historical conversation is lowest priority unless explicitly required.

---

# 47. Context Compression

MVP may perform deterministic compression.

Allowed:

```text
deduplication
removing repeated logs
extracting failing test lines
diff summarization
path indexing
structured metadata
```

Do NOT rely on another LLM just to summarize every context item.

LLM compression may be an optional later strategy.

---

# 48. Context Cache

If both agents have already seen unchanged context:

```text
do not resend it
```

Use content hashes.

Example:

```text
sha256(file content)
```

Track:

```text
agent_id
context_hash
last_seen_at
```

---

# 49. Artifact References

Large content should be referenced, not embedded.

Example:

```yaml
artifact:
  id: ART-99
  type: diff
  path: runtime://artifacts/ART-99
  estimated_tokens: 8120
```

Agent may request:

```yaml
artifact_request:
  id: ART-99
  range:
    start: 120
    end: 220
```

---

# 50. Logging

Logs should be structured JSON internally.

Human-readable CLI output may be formatted.

Never log:

```text
raw secrets
full Authorization headers
private keys
sensitive .env contents
```

---

# 51. Testing Strategy

## Unit Tests

Must cover:

```text
protocol validation
task state machine
context ranking
token estimation
routing rules
security policy
path boundary checks
```

---

## Integration Tests

Must cover:

```text
task creation
Claude adapter execution
structured result
review request
challenge resolution
token metrics
SQLite persistence
restart recovery
```

---

## Cross-Platform Tests

CI MUST run on:

```text
macos-latest
windows-latest
ubuntu-latest
```

Required before release.

---

# 52. CI Matrix

GitHub Actions example target:

```yaml
strategy:
  matrix:
    os:
      - macos-latest
      - windows-latest
      - ubuntu-latest

    node:
      - 22
```

Tests must not silently skip Windows.

---

# 53. Windows-Specific Tests

Must test:

```text
drive-letter paths
backslash paths
spaces in paths
PowerShell environment
process spawn
SQLite locking
Ctrl+C shutdown
```

Example path:

```text
C:\Users\Test User\Projects\Demo App
```

---

# 54. macOS-Specific Tests

Must test:

```text
spaces in ~/Library paths
Apple Silicon
process spawn
filesystem permissions
```

---

# 55. Linux-Specific Tests

Must test:

```text
XDG config paths
headless environment
permissions
system shell differences
```

---

# 56. Package Distribution

Future target:

```text
npm install -g agent-collaboration-runtime
```

or:

```text
npx agent-collaboration-runtime
```

Optional later:

```text
Homebrew
WinGet
Scoop
AUR
```

Do not require Homebrew for core installation.

---

# 57. Development Setup

Primary development machine:

```text
macOS
Node.js 22+
pnpm
Claude Code
Git
```

Start:

```text
pnpm install
pnpm build
pnpm test
pnpm dev
```

All npm scripts must work on Windows.

Avoid shell syntax such as:

```json
{
  "scripts": {
    "clean": "rm -rf dist"
  }
}
```

Use cross-platform Node scripts instead.

---

# 58. Phase 1 — Foundation

Implement first:

```text
monorepo
protocol schemas
SQLite storage
event model
task state machine
CLI
platform abstraction
token estimator
```

Do not integrate ChatGPT or Claude first.

The core domain must work independently.

---

# 59. Phase 2 — Claude Code Adapter

Implement:

```text
detect Claude executable
execute scoped task
capture structured completion
track process lifecycle
cancel execution
collect result
```

Create a fake adapter for tests.

---

# 60. Phase 3 — Context Broker

Implement:

```text
context store
ranking
deduplication
token budget
hash cache
artifact references
minimum-context bundles
```

---

# 61. Phase 4 — ChatGPT Interface

Implement ChatGPT-facing tools such as:

```text
create_task
get_task
list_tasks
request_implementation
get_result
request_review
submit_review
get_decisions
get_metrics
```

The interface should expose business operations, not low-level database access.

---

# 62. Phase 5 — Review Loop

Implement:

```text
review request
challenge
challenge response
changes requested
completion
stop conditions
```

---

# 63. Phase 6 — Token Telemetry

Implement dashboard-ready metrics:

```text
baseline tokens
actual tokens
saved tokens
agent turns
context cache hits
review rounds
```

---

# 64. Phase 7 — Benchmark

Implement reproducible benchmark tasks.

Every optimization must be measured against baseline.

A token optimization must not be accepted solely because it "looks smaller."

---

# 65. First End-to-End Demo

The first demo should be:

## User in ChatGPT

```text
Add a health-check endpoint to this service.
```

ChatGPT creates:

```text
task
scope
acceptance criteria
```

Collaboration Hub sends minimum task context to Claude.

Claude:

```text
reads relevant files
implements endpoint
runs tests
returns structured result
```

ChatGPT receives only:

```text
summary
changed files
tests
uncertainties
token metrics
```

If no concern exists:

```text
task completed
```

If concern exists:

```text
request exact diff/file range
review
challenge if necessary
```

---

# 66. README Demo Metric

README should eventually show something like:

```text
Task: Add health-check endpoint

Traditional full-context handoff:
12,850 tokens

ACR:
4,120 tokens

Reduction:
67.9%

Tests:
42 / 42 passed

Review defects:
0
```

This demonstrates product value immediately.

---

# 67. Success Criteria for MVP

The MVP is successful when:

1. ChatGPT can create a structured task.
2. Claude Code can receive and execute it.
3. Claude returns a structured result.
4. ChatGPT can request focused additional context.
5. A review/challenge can be completed.
6. The system persists task/decision history.
7. The same runtime works on macOS, Windows, and Linux.
8. The benchmark shows measurable token savings.
9. Optimized runs do not regress acceptance-test success compared with baseline.
10. No browser DOM scraping is required.

---

# 68. Architectural Rule

Keep this rule visible in the codebase:

> **Agents do not share conversations. They share evidence, tasks, decisions, and only the context necessary for the next action.**

---

# 69. Product Differentiation

This project is NOT primarily:

```text
an agent launcher
an agent chat room
an agent dashboard
a shared-memory service
a Claude-to-ChatGPT bridge
```

Its differentiation is:

```text
token-aware collaboration
minimum necessary context
structured handoff
evidence-driven review
deterministic stop rules
quality-aware benchmarking
cross-platform local-first runtime
```

---

# 70. Future Scope

Only after the MVP is stable:

```text
Codex adapter
Gemini adapter
OpenCode adapter
agent capability registry
dynamic agent routing
cost-aware routing
model-aware context budgets
repository semantic index
GitHub / GitLab integration
PR review workflow
team server mode
shared organizational policies
agent reputation
failure history
adaptive review policy
```

---

# 71. Potential Future Architecture

```text
                         Human
                           │
                           ▼
                      ChatGPT
                           │
                           ▼
              ┌─────────────────────┐
              │ Collaboration Hub   │
              │                     │
              │ Context Broker      │
              │ Token Governor      │
              │ Task Router         │
              │ Decision Ledger     │
              │ Conflict Resolver   │
              │ Evaluation Engine   │
              └──────────┬──────────┘
                         │
          ┌──────────────┼───────────────┐
          │              │               │
          ▼              ▼               ▼
     Claude Code        Codex         OpenCode
          │              │               │
          └──────────────┼───────────────┘
                         ▼
                    Repository
```

---

# 72. Development Rules for Claude Code

When implementing this repository:

1. Follow this SPEC unless a documented architectural decision supersedes it.
2. Do not add additional infrastructure without clear need.
3. Prefer deterministic logic before LLM-based logic.
4. Keep all provider-specific code behind adapters.
5. Never assume macOS-only behavior.
6. Every filesystem operation must be cross-platform.
7. Every process execution path must be tested on Windows.
8. Do not use Bash scripts for core workflows.
9. Do not introduce browser DOM scraping.
10. Add tests with every core feature.
11. Keep protocol payloads versioned.
12. Do not expose arbitrary shell execution remotely.
13. Record architectural decisions in `docs/adr/`.
14. Measure token optimization against a baseline.
15. Never claim an optimization is successful if task quality regresses.

---

# 73. Initial ADRs

Create:

```text
docs/adr/
```

Initial ADR files:

```text
0001-use-typescript-node.md
0002-use-sqlite.md
0003-minimum-necessary-context.md
0004-no-dom-scraping.md
0005-cross-platform-first.md
0006-structured-agent-protocol.md
```

---

# 74. First Implementation Order

Claude Code should implement in this exact order:

```text
1. Initialize monorepo
2. Add TypeScript configuration
3. Add platform abstraction
4. Define protocol schemas
5. Implement SQLite storage
6. Implement event model
7. Implement task state machine
8. Implement CLI
9. Implement token estimator
10. Implement Context Broker
11. Add FakeAgentAdapter
12. Implement ClaudeCodeAdapter
13. Implement ChatGPT-facing interface
14. Implement review/challenge workflow
15. Add telemetry
16. Add benchmark harness
17. Add macOS/Windows/Linux CI
18. Build first end-to-end demo
```

---

# 75. Definition of Done

A feature is done only when:

```text
implementation complete
tests pass
Windows-compatible
macOS-compatible
Linux-compatible
no undocumented protocol changes
no security boundary regression
telemetry added where relevant
documentation updated
```

---

# 76. Final Product Principle

The runtime should always prefer:

```text
less conversation
more structure

less duplicated context
more references

less model agreement theater
more evidence

less agent activity
more task completion
```

The product succeeds when the developer feels like multiple AI tools are cooperating as a disciplined engineering team without paying the token cost of making every agent know everything.
