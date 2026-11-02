# Routing policy rationale (routing-v0.4)

Executable rules: `routing.yaml`. Enforced by `services/laya-router/decision.ts`; the controller adds AFM self-escalation and failure fallbacks.

Order of precedence (first match wins):

1. **Destructive command** in the request → `ASK_USER`. Safety rules are never overridden by a model.
2. **Verification task** → `RUN_VERIFICATION` (tests run through OpenCode, not AFM).
3. **Research-critical** numerical code → frontier. Unverified local edits must not pass.
4. **`always_frontier` task types** (multi-file change, design) → frontier.
5. **Too many files** (`afm.max_files`) or **capsule too large** (`afm.max_input_tokens`) → frontier.
6. **AFM unavailable** → frontier.
7. **`local_task_types`** → `LOCAL_AFM`, with the skill from `skills`.
8. Otherwise → `ASK_USER`.

v0.3: `other` (general questions and chat) is a local type, because `afm` became the default OpenCode agent. Without it, every unclassified chat turn ended as `ASK_USER`.

After routing to `LOCAL_AFM`, the controller still escalates when:
- AFM triage sets `escalate: true`
- guided tool selection or the answer step fails (timeout, invalid/schema-violating output, refusal, context overflow)
- the answer sets `needs_escalation: true`

Escalation produces a redacted task capsule. The capsule is sent to the frontier only with `--allow-frontier`, or when the user switches to the `codex` agent.

Why these thresholds: 8192 measured context minus schema, system and output reserve. 5500 is a conservative starting envelope, not an optimum. Revisit with 30-day telemetry. Do not change it from single anecdotes.

v0.4: folder overviews (`document_overview`) run a deterministic pipeline: walk the folder, read Spotlight metadata and an excerpt per file, have AFM describe each file, and render the list in code. A free tool loop invented a file name for this task. Questions about PDF, Word, slide or sheet files (`document_question`) read the file locally.
