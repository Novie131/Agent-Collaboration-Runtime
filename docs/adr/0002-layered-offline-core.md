---
status: accepted
date: 2026-09-30
---

# Offline core, opt-in edges

The legacy principle "local, offline, no model calls, no telemetry" is kept, but for the **core packages** only:

- protocol
- storage
- core
- compression
- artifacts
- security
- benchmark statistics
- telemetry analysis
- platform

Core packages never open network connections or spawn agents. Only the edge components may do either, and only when the user explicitly enables them:

- adapters
- remote-bridge
- the daemon
- the Tier 1 benchmark runner

Telemetry is stored only in local SQLite.

This lets the whole domain run in CI on Windows, macOS and Linux with no Claude, no tunnel and no API key. It also keeps the legacy guarantees for the moved code.

## Consequences

A CI import check fails any core package that imports `node:http[s]`, `node:net`, `node:child_process`, the MCP SDK, an adapter, or remote-bridge. Git access for result verification is injected into core through an interface.
