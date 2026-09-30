---
status: accepted
date: 2026-09-30
---

# Claude pull mode first; Agent SDK second; no `claude -p` on a subscription login

ACR must work for users who pay for Claude with a claude.ai subscription and for users with an API key.

The Agent SDK docs say third-party products may not offer claude.ai login ("Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK"), and `--bare` needs an API key. The Agent SDK is therefore API-key only.

The MVP adapter is **pull mode**. The developer's own Claude Code session (CLI or VS Code) calls the hub's local MCP tools:

- It works with both billing modes and in VS Code.
- It reuses the legacy transcript usage parser.

The Agent SDK adapter (dispatch mode, API key) comes in phase 2. It adds code-enforced permissions via `canUseTool`, budgets, and complete usage, and it is required for the Tier 1 benchmark.

## Considered Options

- **Spawn the user's installed `claude -p` with their login.** Not adopted. It is a terms grey area, so revisit only if Anthropic clarifies.
- **Channels (push into a running session).** Rejected. It is a research preview, needs a development flag, is stdio-only, and is CLI-only.

## Consequences

In MVP the hub cannot enforce command policy inside Claude Code. It relies on a recommended permission settings snippet plus post-hoc verification against git.

Pull-mode usage is a **lower bound**: interactive transcripts omit title generation, the permission classifier, and compaction usage.
