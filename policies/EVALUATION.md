# Outcome criteria (draft, for Phase 3–4)

A task counts once, at task level, regardless of how many model calls it took.

| Outcome | Definition |
|---|---|
| `local_verified` | AFM answered; a deterministic check passed (schema valid + cited path:line exists; for edits: proposal applies and tests pass) |
| `local_unverified` | AFM answered; no deterministic check was possible |
| `escalated_recovered` | started local, escalated, frontier completed |
| `frontier_first` | routed to frontier directly |
| `asked_user` | stopped for approval or missing information |
| `failed` | no usable result |

Signals to log per task: route, reason code, policy version and hash, skill, capsule tokens, AFM latency per step, tool calls, escalation reason, frontier latency, and user feedback when given.

Not measured yet: correctness of explanations (needs human or frontier review on a sample) and the false-local rate (needs counterfactual runs — Phase 4, approval required).
