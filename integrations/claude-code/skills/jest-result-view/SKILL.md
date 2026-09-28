---
name: jest-result-view
description: Run this project's Jest through agent-efficiency to get a checked, shorter result view. Use when running Jest tests in a project that has Jest installed locally.
---

Run Jest with:

`npx agent-efficiency test --mode optimize --policy jest-v1 --allow-experimental --project-root . --run-dir .agent-efficiency/runs/<new-name> -- <jest args>`

- Use a new `--run-dir` every run. The exit code is Jest's own; 124 = timeout, 125 = wrapper error (not a test result).
- Read every failure in the output. If it says `returned raw output (fallback …)`, read the raw output as usual.
- When you need something listed under "Omitted", run the `agent-efficiency expand … --part <part>` command it shows. Expanding never re-runs tests.
- A stored artifact describes that run only. After editing code, run the tests again; never cite an old artifact as proof.
- Do not lower reasoning effort, skip, delete or narrow required tests because of this tool.
