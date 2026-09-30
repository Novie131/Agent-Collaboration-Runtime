---
status: accepted
date: 2026-09-30
---

# Two-tier benchmark; only Tier 1 may support claims

ChatGPT Web cannot be automated (no DOM scraping, ADR-0010), so benchmarks run with it cannot be reproduced. The benchmark therefore has two tiers.

**Tier 1 (phase 2)** is automated:

- An OpenAI API model with the same remote tools stands in for ChatGPT.
- Claude runs through the Agent SDK.
- A scripted harness reproduces the copy/paste baseline.
- Runs are repeated, and the legacy paired statistical gates (Tango score, task-cluster bootstrap) judge the results.

**Tier 2 (MVP)** is a small manual pilot in real ChatGPT Web. It is supporting evidence only.

README and public claims may cite only Tier 1 results with outcome `validated_for_scope`, together with their scope.

## Considered Options

- **Draft SPEC §35: one baseline run and one optimized run per task, pass/fail only.** Rejected. With a single run per arm, model randomness alone can flip conclusions.
- **Manual pilot only.** Rejected as the basis for claims because it cannot be reproduced.

## Consequences

The Tier 1 runner is an opt-in edge component with paid API calls and an explicit budget. It depends on the Agent SDK adapter.
