---
status: accepted
date: 2026-09-30
---

# No DOM scraping or UI automation

ACR never scrapes the ChatGPT DOM and never automates browser, desktop or VS Code UI. All integration goes through documented interfaces: MCP connectors, the Claude Code MCP client and plugins, and later the Agent SDK. UI automation is fragile, often breaks terms of service, and cannot be tested across three OSes.

## Consequences

ChatGPT Web cannot be driven automatically, so the developer drives each step (ADR-0003) and reproducible benchmarks need an API stand-in (ADR-0007).
