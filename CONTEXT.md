# Agent Collaboration Runtime

A local hub through which ChatGPT (architect/reviewer) and Claude Code (implementer) exchange tasks, results, evidence and decisions instead of conversations. The developer drives every step.

## Language

### Actors and places

**Hub**:
The local ACR process that stores collaboration state and serves both endpoints. It suggests and refuses; it does not orchestrate.
_Avoid_: Orchestrator, router, server

**Developer**:
The human who drives each step and has final authority over tasks and guards.
_Avoid_: User (ambiguous with ChatGPT's "user"), operator

**Remote endpoint**:
The MCP endpoint that exposes ChatGPT's tools. It is the only thing a Remote bridge may expose.
_Avoid_: Public API, server

**Local endpoint**:
The MCP endpoint that exposes Claude Code's tools. It is reachable only on 127.0.0.1.

**Remote bridge**:
The component that makes the Remote endpoint reachable from ChatGPT Web, for example the OpenAI Secure MCP Tunnel.
_Avoid_: Tunnel (that is one kind of bridge), proxy

**Workspace**:
A registered repository root. Every Task belongs to exactly one.
_Avoid_: Project folder, repo (in protocol terms)

**Pull mode**:
Claude Code integration in which the developer's own Claude Code session fetches work from the Hub.
_Avoid_: Polling

**Dispatch mode**:
Claude Code integration in which the Hub runs Claude itself (Agent SDK, API key only).

### Collaboration objects

**Task**:
A unit of work with a goal, scope, constraints, acceptance criteria and risk. Its ID is assigned by the Hub.
_Avoid_: Ticket, job, request

**Scope**:
The paths a Task is allowed to change. It also bounds what ChatGPT may read for that Task.

**Result**:
Claude's structured claim about what it did for a Task.
_Avoid_: Report, output

**Verification**:
The Hub's check of a Result against git and test Artifacts. It produces findings.
_Avoid_: Validation (reserved for schema checks)

**Review**:
A verdict (`approve` or `changes_requested`) plus structured comments on a Task.
_Avoid_: Challenge (merged into Review), feedback

**Review comment**:
A claim with a reason, evidence and severity. High severity blocks acceptance until resolved.

**Decision**:
A recorded engineering choice with its reason and evidence. It can be superseded but never edited.
_Avoid_: Note, ADR (ADRs are about ACR itself, Decisions are about the user's project)

**Context request**:
ChatGPT's request for information outside a Task's Scope, fulfilled by Claude.

**Artifact**:
Large content stored and hashed by the Hub and passed by reference.
_Avoid_: Attachment, blob

**View**:
A deterministic compact rendering of an Artifact. It is used only when it is smaller than the raw content and every integrity gate passes.
_Avoid_: Summary (implies an LLM)

**Escalation**:
A Task state that hands control to the Developer after a limit or an unresolvable conflict.

### Events and measurement

**RuntimeEvent**:
An append-only record of something that happened to a Task in the Hub.
_Avoid_: Log entry

**TranscriptEvent**:
A normalized event parsed from an agent's own session transcript (tool call, tool result, usage).
_Avoid_: Event (unqualified)

**Measured tokens**:
Token counts reported by the provider for Claude's requests. In Pull mode they are a lower bound.

**Estimated tokens**:
Token counts computed by ACR's estimator. Used for everything on the ChatGPT side. Never added to Measured tokens.

**Tool I/O estimate**:
The estimated ChatGPT-side cost of Hub tool traffic: each response's size multiplied by the later turns it stays in context.

**Baseline**:
The manual copy/paste workflow between ChatGPT and Claude Code that ACR replaces.
_Avoid_: Full-context handoff (rejected baseline)
