# Agent Efficiency — session analysis

- Generated: 2026-09-28T14:02:05.702Z (agent-efficiency 0.1.0)
- Input: `session.canonical.jsonl` via adapter **canonical** (supported)
- Coverage: 19 parsed, 0 ignored, 0 skipped of 19 lines
- Streams analysed: 2

## Candidate waste findings

| ID | Rule | Subject | Count | Confidence | Stream | Source lines |
| --- | --- | --- | --- | --- | --- | --- |
| F0001 | R001 Repeated identical read | src/config.ts | 3 | medium | main | 2, 3, 7, 8, 11, 12 |
| F0002 | R003 Retrying a command that fails for an environment reason | pnpm test | 3 | high | main | 5, 6, 9, 10, 13, 14 |

### F0001 — R001

- Suggestion: Keep the needed excerpt in working notes or read a narrower range; re-read only after a change or when re-verifying.
- Limitation: A repeated read can be a legitimate re-check \(e.g. before editing\); this is a candidate, not proof of waste.
- Limitation: No file version hash; unobserved external changes cannot be ruled out.
- Event IDs: `c1`, `r1`, `c3`, `r3`, `c5`, `r5`

### F0002 — R003

- Suggestion: Check the prerequisite \(e.g. is the executable installed / on PATH?\) before retrying; error kind: command\_not\_found.
- Limitation: Grouped by cwd and command.
- Limitation: Environment changes made outside observed tools cannot be seen.
- Event IDs: `c2`, `r2`, `c4`, `r4`, `c6`, `r6`

## Token usage (observed)

- Completeness: **complete**
- Requests counted: 2
- T_task: 36,930
- Observed (complete requests only): uncached 2,100, cache read 14,000, cache write 20,200, output 630

## Rule configuration

```json
{
  "R001": {
    "window_calls": 20,
    "min_repeats": 3
  },
  "R002": {
    "window_calls": 20,
    "min_repeats": 3
  },
  "R003": {
    "window_calls": 10,
    "min_repeats": 3
  },
  "R004": {
    "window_calls": 10
  }
}
```

## Disclaimers

- Findings are candidate waste, not proof; none of them blocks the agent.
- Report content is masked on a best-effort basis; masking is not complete protection.
- Token totals describe the observed log only; they are not a measure of savings.
