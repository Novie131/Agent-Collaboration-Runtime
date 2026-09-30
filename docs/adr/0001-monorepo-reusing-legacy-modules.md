---
status: accepted
date: 2026-09-30
---

# Monorepo that moves the legacy modules instead of rewriting them

ACR becomes a pnpm monorepo. The legacy "Agent Efficiency" modules move into `packages/`:

- artifacts
- compression (Jest view + integrity gate)
- runner
- benchmark (Tango score, cluster bootstrap, paired gates)
- security (redaction)
- Claude Code transcript/usage parsing
- R001–R004 diagnostics

They are moved rather than rewritten because they are the only working, tested token-saving and measurement code, and exactly what the new hub needs. The hub and daemon are new.

## Considered Options

- **Full rewrite.** Rejected. It would throw away the value claim, and the draft SPEC's benchmark (single run, pass/fail only) is much weaker than the legacy statistical gates.
- **Separate repo, with the legacy tool as a dependency.** Rejected. It adds release coordination for no gain while there is one developer.

## Consequences

Phase 0 (migration, all legacy tests green on three OSes) must finish before hub work starts. Legacy CLI commands stay as `acr test/expand/analyze/compare/…`.
