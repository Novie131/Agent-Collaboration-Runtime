---
status: accepted
date: 2026-09-30
---

# One outgoing privacy guard on the remote endpoint: mask values, block whole .env files

The developer keeps secrets in `.env` files. Their concern is that those secrets, or personal data inside the code, reach OpenAI through ChatGPT. Turning off model training does not address it, because the data still leaves the machine.

Every remote response therefore passes a single guard before it is sent:

- it masks `.env` values found anywhere in the response, plus personal data and secret patterns;
- it withholds the whole response when it carries several `.env` entries, because at that point it is effectively the file.

The response and the event log record counts, never values.

## Considered Options

- **Mask only, never block.** Rejected. A dump of `.env` masked value by value still reveals which services and keys exist and invites follow-up requests.
- **Block any response containing a secret.** Rejected. Reviews would stall on a single masked value that a placeholder handles well.
- **Filter on the local endpoint too.** Not adopted. Claude reads files directly, so filtering hub responses to Claude would protect nothing. What Claude sends to Anthropic is governed by Claude Code's own permissions.

## Consequences

- Detection is deterministic and can miss secrets that match neither a `.env` value nor a known format. The SPEC states this limit.
- Pattern precision matters in both directions: over-masking code breaks review. Regression tests pin both the true positives and the known false positives.
