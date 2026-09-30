---
status: accepted
date: 2026-09-30
---

# The hub is a human-driven mailbox and gatekeeper, not an orchestrator

The draft SPEC said the hub "decides who needs to act". Neither assistant can be woken by the hub:

- ChatGPT calls tools only during a turn the user started. This was verified on 2026-09-29: there is no push and no conversation resume.
- Claude Code runs in pull mode (ADR-0005).

The hub therefore:

- stores state;
- decides what each side receives;
- **suggests** the next step in every response;
- **refuses** requests past limits or policy.

The developer drives every step. The SPEC describes the system that can actually be built, not the aspiration.

## Considered Options

- **Keep "hub orchestrates" as the vision, with humans standing in for now.** Rejected. It would leave the SPEC describing a system that cannot exist on the ChatGPT side.
- **Poll from Claude (e.g. `/loop`).** Rejected. It spends Claude tokens on idle polling, which is the opposite of the product goal.

## Consequences

The Token Governor and Routing in MVP are hard limits plus `next` hints. When the Agent SDK adapter lands (phase 2), dispatch on the Claude side becomes real. The ChatGPT side stays human-driven.
