---
status: accepted
date: 2026-09-30
---

# Separate remote and local MCP endpoints; tunnel org scoping as MVP auth

The hub serves two MCP endpoints from one process, both bound to 127.0.0.1:

- `remote`: ChatGPT tools only. It is the only endpoint given to a RemoteBridge.
- `local`: Claude tools. It is never bridged.

The OpenAI Secure MCP Tunnel forwards **every** tool of the server it fronts, and per-tool exposure is not documented. With one endpoint, ChatGPT could call `submit_result` or `get_task`. Separate endpoints make that impossible by construction.

MVP remote authentication relies on the tunnel itself. The tunnel is outbound-only, authenticated with an OpenAI runtime API key, and restricted to the owning Platform org or workspace and to users with Tunnels Read + Use.

## Considered Options

- **Hub OAuth in MVP.** Rejected for now. Building an authorization server is costly, and MCP auth just moved from DCR to CIMD (spec 2026-07-28), so early work would likely be redone.
- **Single endpoint with caller detection.** Rejected. Requests that arrive through the tunnel cannot be reliably told apart from local ones.

## Consequences

Any bridge other than the OpenAI Secure MCP Tunnel (cloudflared, ngrok, public HTTPS) is forbidden until the remote endpoint implements OAuth (CIMD). A contract test asserts that local tools are absent from the remote endpoint.
