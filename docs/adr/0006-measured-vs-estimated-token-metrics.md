---
status: accepted
date: 2026-09-30
---

# Headline metric: measured Claude tokens and estimated ChatGPT tokens, never summed; copy/paste baseline

The draft SPEC measured "transferred context" against a full-context handoff baseline. That baseline guarantees large savings by construction, and it ignores where the cost really is.

The headline metric is **total task tokens**, reported as two separate numbers:

- **Claude, measured:** from transcript or SDK usage.
- **ChatGPT, estimated:** cumulative tool I/O, meaning each remote tool response's size × (1 + later remote calls in the task).

ChatGPT exposes no per-conversation token counts to end users (verified 2026-09-29). Its side can only be estimated, and the estimate is a lower bound.

The two numbers are labelled and never added together. The baseline is the manual copy/paste workflow the product replaces. Transferred-context tokens remain as a secondary diagnostic only.

## Consequences

Every estimate stores the estimator's identity and version. `acr metrics` shows `measured (lower bound, incomplete: …)` for pull-mode sessions.
