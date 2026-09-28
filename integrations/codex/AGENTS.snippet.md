<!-- UNVERIFIED with Codex: no Codex install or real session sample was available. See docs/integrations.md. -->
## Running Jest

Run Jest through `npx agent-efficiency test --mode optimize --policy jest-v1 --allow-experimental --project-root . --run-dir .agent-efficiency/runs/<new-name> -- <jest args>`.
Read every failure. If the output says it fell back to raw output, read that as usual. Use the `agent-efficiency expand … --part <part>` command it prints when you need omitted detail; this never re-runs tests. After code changes, run the tests again rather than relying on an old artifact. Never skip or narrow required tests because of this tool.
