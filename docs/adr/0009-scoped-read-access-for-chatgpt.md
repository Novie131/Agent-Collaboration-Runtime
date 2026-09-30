---
status: accepted
date: 2026-09-30
---

# ChatGPT reads only task-scoped files; the hub computes the diff

Through the remote endpoint, ChatGPT may read:

- the task's artifacts;
- files in the task's `scope.paths`;
- files changed in the task.

It never reads the rest of the repository. The hub computes the diff with read-only git, so ChatGPT sees the actual change rather than Claude's description of it. Anything outside that scope goes through `request_context`, which Claude fulfils.

## Considered Options

- **Artifacts only.** Rejected. Every review read would cost a human step and Claude tokens.
- **Whole-workspace read.** Rejected. It exposes the whole repository to OpenAI through the tunnel, which breaks deny-by-default.

## Consequences

All reads go through the workspace boundary, the secret deny-list and redaction. Large files require a line range.
