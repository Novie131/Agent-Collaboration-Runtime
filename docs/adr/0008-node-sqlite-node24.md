---
status: accepted
date: 2026-09-30
---

# `node:sqlite` on Node 24+ behind a storage interface

Storage uses the built-in `node:sqlite`, wrapped in a thin `packages/storage` interface. The minimum runtime is Node 24 (the draft said 22+). CI runs Node 24 and 26.

This avoids native-addon builds, the most common cross-platform install failure. `better-sqlite3` needs a toolchain on Windows whenever no prebuild exists for a new Node version. It also keeps dependencies minimal, as the legacy code does.

## Considered Options

- **`better-sqlite3`.** It is mature and fast, but a native addon. It remains the fallback: swapping means changing one module.

## Consequences

`node:sqlite` is experimental on Node 24 and a release candidate from Node 25.7; it was still RC on 26.10. The module-specific ExperimentalWarning is suppressed on Node 24. The hub's use of SQLite stays simple: one process, transactions, an append-only event log.
