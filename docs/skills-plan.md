# Skills, graph and loop: the improvement plan (2026-11-06)

Why: features were added one regex and one special case at a time (43 routing tests in the controller, 28 in
local-skills, ~20 stages in one `handle()`), and nothing measures a feature on its own. A fix for one request can
break another, and the same mistake comes back. This plan turns the features into **skills** with a contract,
puts a **check that can fail** inside each one (the loop), wires them with explicit **nodes, edges and gates**
(the graph), and makes every accepted fix a **permanent constraint** checked by evals (the learning edge).

Goals that do not change (they are the acceptance test of every phase):

1. Local first: AFM, Decima, Copilot inline completion and Spotlight do as much as they can, at no cost.
2. Few frontier calls: Codex only through a gate, and with a redacted capsule (summaries, paths, line ranges), not
   raw documents. Measured per task: frontier calls, bytes sent.
3. Quality at Codex-alone level on the benchmark suites (code-eval, framework-eval).
4. Nothing that works today breaks: every phase ships behind a flag, runs in shadow first, and must pass the
   eval gate (no regression in any skill) plus `npm test`.

## 1. Skill packs (what exists today, grouped)

| pack | what it holds today | lane |
|---|---|---|
| `core` | triage, routing, final answer, citation/grounding checks, memory, escalation | contained |
| `files` | find files (name), folder overview, document questions, sheets, slides, action-item tables, MCP read_document/find_files | contained |
| `code` | small edits, local code jobs, codegen, Copilot S5 tier, afm_code, docstrings, error triage, rename | wide (branch) |
| `git` | git overview, GitHub status, change summary, commit message, release notes, job list/compare/apply, sessions | contained (apply: wide) |
| `writing` | LaTeX compile/refs/table/polish, afm_write, afm_summarize, translation | contained |
| `mac` | open app/terminal/editor, launch app, Mac health, command help, run command (approval) | contained |
| `security` | security check, privacy scan (the security gate itself stays in core code, not a skill) | contained |
| `web` | web search (approval), SearXNG / fallbacks | contained, egress |
| `frontier` | Codex hand-off (read-only answer, worktree session), Copilot chat hand-off | egress |

Each pack is a folder `skills/<id>/` with `skill.json` (the contract, §2), `evals/cases.jsonl` (public cases on
fixtures or this repository) and later `constraints.md` (the learning edge, §6). Code stays where it is; the
manifest points at it. Moving code is not part of this plan.

## 2. The skill contract (`skill.json`) and compatibility rules

Fields: `id`, `version` (semver), `contract` (manifest format version), `description`, `examples` (requests it
must take; used by the router in phase 3 and by evals), `reasonCodes` (the controller reason codes this skill
owns; exact or `prefix_*`), `capabilities` (`read`, `propose`, `job`, `run_approved`, `network`, `frontier`),
`lane` (`contained` | `wide` | `irreversible`), `egress` (`none` | `query` | `capsule`), `checks` (the GREEN
conditions its loop uses), `budget` (AFM calls, latency, frontier calls per request).

Rules the registry enforces (load fails in tests and in development; a third-party skill is skipped):

- ids unique; every reason code owned by exactly one skill; every reason code the controller emits is owned
  (a test scans the controller), so a new branch cannot ship without a skill.
- A manifest can only **narrow** what the security gate allows, never widen it. `irreversible` work (delete,
  push, send, migrate, credentials) has no automatic lane: it is not a high threshold, it is a closed lane.
- `frontier` capability implies `egress: capsule`; `network` implies `egress: query` or more. A skill that says
  `egress: none` and makes a network call fails its eval (the runner checks).
- `contract` major version must match the registry; new optional fields are added in minor versions only.
- Third-party skills (phase 6+, `~/OnBud/skills.d/`) are off by default, cannot declare `frontier`,
  `run_approved` or `irreversible`, and run with read + propose only.

## 3. The graph (between nodes)

Node kinds (from the referenced post, mapped to this system):

- **Splitter**: the router and the job planner. It decides which units exist; it is where the learning edge lands.
- **Worker**: one skill doing one unit with one lens, in its own context (AFM for text, Copilot for code,
  Codex as the worker of last resort).
- **Code node**: anything with one correct answer: Spotlight/mdfind queries, ranking, dedupe, merge, diff
  checks, test runs, language detection, redaction. Never a model call.
- **Gate**: decides what goes on. Reads evidence in this order: deterministic results → this run's trajectory →
  how often this node's work was rolled back → Decima's difficulty score → the model's own claim (last).

Edges only where a value crosses. Independent nodes run in parallel: e.g. name search ∥ content search ∥ Decima
scoring; reading three documents ∥. Every arrow in today's chain is checked with "does the next step read the
previous one's output?"; where it does not, the wait is removed (phase 4).

Tiers as nodes (cost order): code nodes (free) → AFM (free, on-device) → Copilot inline (free, code only) →
Decima (free, a score for the gate) → Codex (subscription, egress). Codex gets a unit only when the gate says
so, and gets the unit, not the whole conversation.

## 4. The loop (inside a node): produce → check → correct → repeat until green

The check is written first and is a program. Per pack:

| pack | GREEN (programmatic) | not a check |
|---|---|---|
| core | reply language = request language; every cited path exists; quoted lines are in the evidence | "looks fine" |
| files | each result exists, and its name/title/content matches the query's topic terms | model confidence |
| code | tests exit 0; the diff touches only the planned files; no stub left | "no error raised" |
| git | numbers/branches in the answer equal `git` output | |
| writing | latexmk exits 0; citation keys and \ref labels unchanged; markup tokens preserved | |
| mac | the app/window opened (exit code, window check) | |
| security | every finding has file:line and a masked value | |
| web | every claim carries a source URL that was fetched | |
| frontier | capsule passes redaction; frontier calls ≤ budget | |

A failed check returns the **unit, not the batch**, with four things: UNIT, VERDICT, REASON, EVIDENCE, and
SCOPE ("fix this file only"). At most three corrections; a unit failing three times goes back to the splitter
(the plan was wrong), or to the user.

## 5. Gates and lanes (blast radius, not confidence)

- **contained** (answers, proposals, read-only): opens first, automatic.
- **wide** (local jobs on their own branch, multi-file edits): deterministic checks + clean trajectory; the human
  approves once, at the merge ("반영"). Not at each step.
- **irreversible**: never automatic, whatever the score.
- **egress gate** (any frontier or web call): allowed only by policy + approval rules that exist today; the
  payload is the redacted capsule; the eval runner counts bytes sent.

## 6. Return paths

- **Correction edge** (short): the gate sends one unit back to its producer, with the scope line (§4).
- **Learning edge** (long): an accepted fix becomes a constraint in `skills/<id>/constraints.md`, which the
  splitter/worker reads ("folder names in the request are search scope, not search terms"). A constraint is
  accepted only with an eval case that fails without it and passes with it. Constraints are versioned like code.

## 7. The improvement loop (how fixes are made from now on)

1. A failure (user report or a red eval) becomes an eval case first: the request, the fixture, the GREEN checks.
   Personal cases (real paths, real documents) go to `~/OnBud/runtime/evals/private/` and are never committed.
2. The case is red on the current code (baseline).
3. One skill is changed, scope-limited to that skill (by hand or by Codex in a worktree with that scope).
4. `tools/skill-eval.ts` runs all skills: the case turns green and no other case turns red (the gate).
   `npm test`, framework-eval (s2/s3) and code-eval (S5) must not regress for changes to `core` or `code`.
5. Accepted: commit with the case; derive a constraint if the cause is general (learning edge).
6. The scorecard records the path, not only the answer: route, skill, AFM calls, frontier calls, bytes sent,
   latency. A cheaper path at the same score is an improvement too.

## 8. Where Shortcuts fit

- **Triggers (entry points)**: hotkey, Share Sheet ("Ask OnBud about this file"), Focus/time automations.
  They call the `afm` CLI or the controller's local API; no logic in the shortcut.
- **Tool nodes for macOS-only actions**: Calendar, Reminders, Notes, Mail drafts, Photos, Focus, Ghostty App
  Intents, via `shortcuts run <name>` as a code node. An allow-list in `skills/mac/shortcuts.json` names each
  shortcut, its input/output and its lane; sending, deleting or paying shortcuts are irreversible: closed lane.
- **Not**: the loop or graph engine (no versioning, diff or tests, slow, weak state and branching), and not
  calling Apple Intelligence models through Shortcuts as an API (the model notice forbids programmatic access
  through Apple software except as expressly permitted).
- Scheduled evals run from launchd (or a Personal Automation that calls the same script), not inside Shortcuts.

## 9. Security and distribution

- Manifests and cases in the repository contain no personal paths, names or documents; a test checks for `/Users/`
  and home-folder names. Private cases live in runtime/ (git-ignored, mode 700).
- Skills get capabilities, not code access: a manifest cannot enable network, frontier or writes the gate
  forbids; external skill folders are read + propose only.
- File and web contents are data, never instructions (unchanged); constraints are written only from accepted,
  eval-backed fixes, never from document text.
- The eval runner runs with `readOnly`, no frontier and `ONBUD_BENCH=1` (its log lines are marked and left out
  of calibration). It opens no apps and starts no jobs.

## 10. Phases (each: flag off by default → shadow → eval gate → on)

| phase | work | exit criteria |
|---|---|---|
| P0 (done 2026-11-06) | manifests for 9 packs, registry + coverage test, programmatic checks, `skill-eval.ts` (`--repeat`, `--baseline` gate), seed cases from known failures, baseline scorecard | npm test green; no behavior change |
| P1 (done 2026-11-06) | core contracts: reply-language contract (detect from request text without paths/quotes/identifiers; post-check on every answer; masked translation, original kept if a masked part is lost), `ONBUD_LANG_CONTRACT` on/shadow/off | reply-language family green; 0 regressions |
| P2 (done 2026-11-06) | files: find frame (names, topic, content cue; en/ko), name ∥ title ∥ content Spotlight search, merged ranking with "matched by", "which file mentions X" recognised, Unicode file names; generated public fixtures (`fixture:topic-docs`); `ONBUD_FIND_TOPIC=off` | find-by-topic family green (4 wordings); Sparse Attention fixed; 0 regressions |
| P3 | router: skill choice from manifests (AFM enum over descriptions + examples) in shadow next to the regex chain; switch per skill when they agree on evals and real logs | agreement ≥ 95% on cases; no regression |
| P4 | graph executor for multi-unit work: parallel independent nodes, unit return with scope, 3-attempt cap; first user: local jobs | job evals green, time ↓ |
| P5 | learning edge: constraints files, eval-backed | constraints have cases |
| P6 | Shortcuts tool nodes (allow-list) and triggers; third-party skills folder (read + propose) | mac cases green; closed lanes tested |

## 11. Baseline (P0, 2026-11-06, single runs, AFM on macOS 27.2)

9/17 green: code 1/1 · core 1/3 · files 2/5 · git 0/2 · mac 2/3 · security 1/1 · web 1/1 · writing 0/1.
The red cases are the work list, in plan order:

- core (P1): a Korean request answered in English (`core-ko-answer-ko`); a plain README summary escalated.
- files (P2): "about Sparse Attention in the content" searched the words "research, paper, about" by name; content
  search finds the paper. "Which file defines the routing thresholds?" answered `routes.py` (does not exist).
- git: "What is the current git branch?" escalated on the answer guardrail instead of reading `git branch`.
- mac (P3, router): "Check the health of my Mac." missed the Mac-health skill (the regex wants "mac … health").
- writing: "compile the LaTeX paper here" with no .tex file went to a generic answer that invented a path.

AFM's answers vary between runs (one case flipped between two runs): the gate uses `--repeat 3`.

## 12. Generality: skills that work on other people's Macs (added 2026-11-06)

A fix that only makes one of the author's requests pass ("find the Sparse Attention paper") is not accepted. Gate:

- **Public paraphrase families.** Each fix lands with ≥ 3 public cases of the same family (`"family"` in the
  case): two wordings, both languages (ko/en), on repository fixtures or generated fixtures, plus the private
  case that triggered it. A family must pass as a whole.
- **No new trigger regex without a family.** Routing words belong in the manifest's `examples` (P3 router), not
  in new regexes in the controller; a regex may stay only as a fast path that a family covers.
- **Environment profiles.** Skills declare `requires` (`apfel`, `spotlight`, `decima?`, `copilot?`, `searxng?`,
  `gh?`, an app); `?` means optional with a fallback. The eval runs in two profiles: full (this Mac) and minimal
  (Decima, Copilot, web and gh off; Spotlight index assumed). A skill must pass its minimal-profile cases.
- **Locale and apps.** No assumption about the user's language, terminal (Ghostty/iTerm/Terminal), editor or
  folder names; the user's choices come from `config/apps.json` or the system default (already the case for
  terminals and editors).

## 13. New and extended skills (common Mac work)

Usage surveys (Setapp Mac Apps Reports 2021–2023) put built-in apps first: most of the apps used daily are
pre-installed (Safari, Messages, Photos, Mail, Calendar, Notes, Finder), then Office, Chrome and Adobe. The
tasks people automate most on the Mac are image resize/convert, PDF merge and images → PDF, and file
organisation. That gives:

| skill | what | how (code nodes first) | lane | decision |
|---|---|---|---|---|
| `convert` (new) | image resize/convert (sips), PDF merge/split/pages → images (PDFKit helper), doc ↔ txt/html/rtf/docx (textutil), zip | built-in CLIs and a small Swift helper; output is a new file next to the input, never an overwrite | contained | new pack: it writes files, `files` only reads |
| `organize` (into `files`) | rename/move by rule, duplicates, Downloads clean-up, sort by type/date | plan → dry-run list → user approves → move (never delete; Trash only on approval) | wide | extends `files` with a `job`-like approved step |
| `personal` (new) | Calendar events, Reminders, Notes, Contacts: read, and create on approval | EventKit/Contacts via a Swift helper (TCC prompt once), Shortcuts as fallback | read: contained; create: wide; delete/send: irreversible (closed) | new pack: personal data, its own egress rule (never to a frontier) |
| `shortcuts` (new) | list/run allow-listed shortcuts; install shortcuts from a vetted template catalogue; find a missing one a skill needs and offer it | `shortcuts list/run/sign`; templates are versioned plist files in the repo, signed with `shortcuts sign`, imported by `open` (the user confirms Apple's import dialog) | run: per shortcut; install: wide | new pack, also the tool-node provider for other packs (§8) |
| `mac` (extended) | system toggles (appearance, volume, Do Not Disturb/Focus via Shortcuts), clipboard, screenshots (`screencapture`), quit/hide apps, battery and storage (existing health check) | osascript/System Events, `pmset`, `screencapture`, `pbcopy`; settings that change security are not offered | contained / wide | stays in `mac` |
| `web` (extended) | the browser's current tab (URL, title, selected text) as context, reading list | AppleScript to Safari/Chrome (TCC prompt once) | contained | stays in `web` |

**Managing shortcuts automatically**: possible within limits. `shortcuts` can list, run, view and sign, but has
no import or edit command (Apple: create and edit in the Shortcuts app); a signed file opened with `open` shows
Apple's import dialog, which the user confirms. So the skill can (1) see which shortcuts exist, (2) install one
from the vetted catalogue when a skill needs it, with one click by the user, (3) run allow-listed ones. It must
not write arbitrary shortcuts with AFM: the action format is undocumented and changes between macOS releases,
and a shortcut can do anything the user can (send, delete, pay). Catalogue entries carry their lane; any
send/delete/pay shortcut is a closed lane for automatic use.

## 14. Memory: what it does today, and strategy memory (SALE)

Today (`services/memory/memory.ts`): per-project notes in SQLite (FTS): `episode` (a grounded Q/A after a
verified local answer), `file_summary`, `lesson` (a fixed sentence after a local failure), `preference`. They are
recalled (k = 3) into the capsule **only on the generic AFM tool-loop path**; local skills, jobs, file search and
the planner do not use them. OpenCode (agent server) and the Spotlight app (same server) have memory; the MCP
`afm_task` tool (Codex → AFM) has none; a chat without a project folder has none. Lessons carry no strategy
("Read the relevant files first or hand off to codex"), so they teach little.

Alazraki et al., *Scaling Small Agents Through Strategy Auctions* (SALE, ICML 2026, arXiv 2602.02751): agents of
several sizes bid short **plans**; all plans and the auction result are stored; a smaller agent retrieves
(losing plan, winning plan) pairs of similar past tasks and rewrites its plan before it executes. Memory lowers
the largest model's share from 35% to about 17%, and a sliding window of the last 10–25 tasks keeps that
(100-task pool, one distribution). Small agents' refined plans name tools and arguments, add cross-checks and,
for code, edge-case tests.

Adapted here (P5, replaces the fixed-sentence lessons):

- **Store plans, not outputs**: the planning units AFM produces (job plans, search frames, tool sequences,
  verification steps), with the verdict of the programmatic checks (GREEN/RED). Our verdicts are better than an
  auction outcome: they are checks, not a jury.
- **Contrastive pairs from our own tiers**: (AFM plan, RED) paired with the plan that went GREEN on the same unit
  (AFM's retry, Copilot's route, or Codex's plan). When a unit goes to Codex, the capsule asks Codex for its
  plan (a few lines) along with the answer; that plan is stored. The large model's planning is reused by AFM at
  test time without sending anything new out.
- **Per skill, generalised, local**: paths and names replaced by placeholders, so a plan can help in another
  project; kept on this Mac only; never sent to a frontier.
- **Retrieval and size**: same skill + FTS5 similarity now (Apple's on-device sentence embedding later), k = 2
  pairs, ≤ 600 characters in all (AFM's context is small); a window of the last 25 records per skill; a record
  that was retrieved and led to RED twice is dropped.
- **Injected only into planning steps** (planner, search frame, answer plan), never as evidence.
- **Measured**: skill-eval with memory on/off, cases in several orders (memory makes order matter), plus Codex
  calls per task. Kept only if it helps.
- MCP `afm_task` gets read-only recall; Spotlight chats without a folder use the per-skill (not per-project)
  strategy memory.

Phases updated: P5 is strategy memory + constraints; `convert`, `personal`, `shortcuts` and the `mac`/`web`
extensions are P6, each with its own families and lanes.

## 15. P1–P2 results (2026-11-06, `--repeat 3`, majority)

| | P0 baseline | P1 + P2 |
|---|---|---|
| families | — | reply-language GREEN · find-by-topic GREEN · find-by-name GREEN · folder-overview GREEN |
| private | Sparse Attention (content) RED | GREEN (the paper ranks first, as a title match) |
| regressions | | 0 |

Still red, for the next phases: README summary escalates (core), "Which file defines the routing thresholds?"
and "List the skills in policies/skills" (files: code/document Q&A grounding), git branch/status questions
(guardrail escalation), "Check the health of my Mac." (router, P3), LaTeX without a main file (writing).

## 16. P6 in detail: new skills with user control, privacy and security (2026-11-06)

User control: `~/OnBud/config/skills.json` `{ "disabled": ["personal"], "options": { "convert": { "maxMB": 200 } } }`,
read by the registry (`enabled(id)`), shown as switches in the Spotlight app's settings. The controller checks the
owning skill before a stage runs; a disabled skill answers how to turn it on. Defaults: `convert`, `shortcuts`
(run/list) and the `mac`/`web` extensions on; `personal` off until the user turns it on (it reads personal data).

| skill | capabilities (contract 1.1 adds `write_new`) | privacy and security rules | tests |
|---|---|---|---|
| `convert` | read, write_new | inputs: files the user named, through the security gate; output: a new file beside the input (`name (converted).ext`), never an overwrite or a delete; size cap; no network | generated fixtures (cupsfilter PDFs, sips images, textutil docs); output checked by `sips -g`, page count, `textutil -info` |
| `organize` (files) | read, propose, job | dry-run list first; moves only after approval; Trash instead of delete, and only on approval; never in ~/Library or secret paths | generated folders; check the moved set equals the approved list |
| `personal` | read, propose | EventKit/Contacts through a Swift helper (macOS asks once per app); results go to the user only: never into memory, a capsule for Codex, telemetry (counts only) or logs; manifest flag `private: true` makes the egress gate refuse any hand-off of its output; create needs approval; delete/send are closed | public tests with a fake provider; real-calendar cases only as private cases |
| `shortcuts` | read, run_approved, propose | run: shortcuts in the vetted catalogue, or one of the user's own by exact name with approval; install: a catalogue file, signed with `shortcuts sign`, imported by the user in Apple's dialog; AFM never writes shortcut actions; catalogue entries that send, delete or pay are closed lanes | `shortcuts list` parsing, catalogue validation, a no-op catalogue shortcut round trip |
| `mac` (ext.) | read, run_approved | appearance, volume, screenshot to a new file; clipboard read only when asked in that request and never stored; nothing that changes security settings | osascript dry runs; state restored after the test |
| `web` (ext.) | read, network | current browser tab (URL, title, selected text) only when asked; the page text stays local unless the user approves a web/Codex step | fake browser state |

During app development the eval runs every skill at full capability on generated fixtures (full profile), and
in the minimal profile; personal-data skills run against fakes in public tests.

## 17. Memory: two stores, kept apart

- **Context memory** (exists): per-project notes recalled into AFM's capsule (episodes, file summaries).
- **Strategy memory** (P5, the functional one): per skill, plans with their check verdicts, used by the
  planners and the escalation step (for example "this kind of unit failed locally twice → hand it to Codex
  early", or the plan Codex used last time). It is separate from context memory because it has a different
  key (skill + task shape, not project), a different reader (planner/gate, not the answer) and different
  privacy (generalised, no paths or content). Lessons move from context memory to strategy memory.
- Nothing from either store is sent to Codex by default; a strategy hint may go into a capsule only as a
  generalised one-line plan, under the same egress gate.

## 18. P4 graph: what it is and what it costs

- A plain data structure in the controller (TypeScript), not a neural graph and not Shortcuts or Obsidian:
  `nodes` (id, kind: splitter | worker | code | gate, skill, input refs) and `edges` (which output feeds which
  input). One graph per request, built by the splitter from the skill manifests; saved as JSON next to a job's
  journal (`runtime/jobs/<id>/graph.json`) so a run can be inspected and resumed.
- Execution: a small scheduler runs ready nodes concurrently. AFM is one model with one slot (apfel
  `--max-concurrent 1`), so AFM nodes still run one at a time; the gain is in code nodes (Spotlight, git, tests,
  file reads) and remote nodes (Copilot, Codex) running beside AFM, and in not running units that are not
  needed.
- Resources: a few KB of JSON per request; no extra process; scheduling overhead in milliseconds. Strategy
  memory: ≤ 25 records per skill × ~15 skills, under 1 MB of SQLite.

## 19. Measurement loop

Exists: `npm test` (unit), `tools/skill-eval.ts` (skills, families, repeat, baseline gate, AFM calls per case),
`tools/bench/framework-eval.ts` (66 own tasks; `--web` added: s3 + web without Codex; AFM and Codex calls per
task), `tools/bench/code-eval.ts` (HumanEval/LCB/ML/S5 with Codex calls). A change is accepted only when the
gates pass. Not yet automatic: picking the next red family, proposing a fix and re-measuring. P7 adds
`tools/improve.ts`: take the reddest family, open a worktree, ask Codex (scope: that skill) for a change, run
the gates, keep it only if the family turns green with no regression, and record the cost/accuracy delta in
`docs/BENCHMARKS.md`. Each run is approved by the user (it spends Codex usage).

## 20. Before/after measurement (2026-11-06, Decima advise on, SearXNG on, no Codex)

Same harness on both versions: pre-skill = 9d01be6, current = P0–P2.

| | pre-skill | current |
|---|---|---|
| framework-eval s3 + web (56 tasks + web G1–G3 with search approved) | 53/56, G 2/3 | 53/56, G 2/3 (0 regressions) |
| AFM calls (56 tasks) / total time | 103 / 174 s | 114 / 187 s (+11 calls: reply translations) |
| skill-eval (27 cases × 3 runs, majority) | 13/27 | 18/27 (+Sparse Attention, +find-by-topic family) |
| skill-eval AFM calls / latency per run | 3.94 / 6.8 s | 3.78 / 6.3 s |
| reply language matches the request (78 runs) | 71 | 75 (the 3 left are escalation notices, which the server renders in the user's language) |

Codex calls are 0 in both (s3). The Codex-only and S1/S5 numbers are in benchmark-notes §5n.

## 21. P3–P7 as built (2026-11-06)

- **P3 router** (`services/skills/router.ts`): after every rule stage and before the generic AFM path, AFM picks
  one of the skills' `entries` (two example requests each) or none; the pick must meet the skill's own
  conditions (`routedSkillApplies`: the files it needs, not a how-to question) and the folder/read-only rules.
  A trigram prefilter was tried and dropped (it keyed on "the" and found nothing for Spanish or Chinese).
  Per-skill switches: `config/skills.json` (`services/skills/settings.ts`); `personal` is off by default.
- **P6 skills** (`services/controller/mac-tasks.ts`, `tools/pdftool`, `tools/pim`): convert, shortcuts,
  mac_control, browser_tab, personal; packs `convert`, `shortcuts`, `personal` (private), extensions of `mac`
  and `web`. Rules for each, router entries for other wordings; none run for delegated tasks.
- **Language**: nine languages (ko, en, ja, zh, es, fr, de, pt, it) detected by script and distinctive
  function words; the contract translates into any of them.
- **P4 graph** (`services/skills/graph.ts`): executor with unit returns and the 3-attempt cap; the find stage
  runs on it; each local job writes `graph.json`.
- **P5 strategy memory** (`services/skills/strategy.ts`): plans and verdicts per skill, generalised, window 25,
  contrast recall into the job planner; the MCP tool reads context memory and never writes it.
- **P7** (`tools/improve.ts`): dry run by default; `--run --yes-spend-codex` tries a fix in a worktree and
  runs the gates there.

## 22. Final before/after (2026-11-06; Decima advise, SearXNG on; pre = 9d01be6, current = 35c43cc)

| | pre-skill | current |
|---|---|---|
| framework-eval s3 + web (56) | 54 · AFM 111 · 207 s | **55** · AFM 122 · 212 s (G1 fixed, 0 regressions) |
| framework-eval s1 (Codex allowed) | 53 · Codex 0 · 221 s | **54** · Codex 0 · 201 s |
| skill-eval (46 cases × 3, majority) | 20/46 · 3.96 AFM calls · 5.8 s per run | **41/46** · 3.57 AFM calls · 6.5 s per run (0 regressions) |
| reply language matches (126 runs, 9 languages) | 113 | 123 |
| code-eval S5 (HE/LCB/ML/mlh dev) | 75/81 · Codex 27 (11-03) | 73/81 · Codex 28 |
| code-eval S1 | 78/81 · Codex 69 (10-31/11-01) | 77/81 · Codex 68 |
| peak memory (process RSS) | ~134 MB (framework/skill runs) | ~136–139 MB; code-eval 110–490 MB, LCB S5 2.8 GB (test sandboxes) |

Code generation (codegen, Copilot S5) did not change in these phases, so S1/S5 differences are run-to-run
variance (AFM, Copilot and Codex are not deterministic). The regressions the gates caught on the way and their
general fixes: router taking file questions (C4/X7) → the router serves requests without a named file and never
starts a writing skill; "I" read as Italian (R3) → capital-only English pronoun; a new file with only an import
(E3) → a code step must define the functions the work names, and Copilot is given their signatures.
Still red: README summary (core), two code-search questions (files), LaTeX with no main file (writing).

## 23. Red cases closed (2026-11-06, after §22)

skill-eval 46/46 green (3 runs each, majority; 2.81 AFM calls and 5.4 s per run, was 3.57 / 6.5 s), framework-eval
s3 + web 54/56 (the one change is G2, a web search whose results vary; it fails on the pre-skill version too).
Fixes, each general: a named folder is listed into the evidence; "which file defines X" searches the request's
content words across the project (Korean via the on-device translator, own-path bonus); a LaTeX request with no
LaTeX project says so; a top-level file named without its extension is found (README → README.md); the older
unmasked Korean translation is off under the contract; a long answer may lose a fifth of its names in
translation (never code, paths, numbers or a short answer's names); more French function words.
Codex alone on the 81 code tasks: 80/81 (LCB 29/30) with 81 Codex calls.

## 24. Code skill loop: stress test for contest-style Copilot code (2026-11-06)

`stressTest()` (codegen.ts): for algorithmic tasks whose Copilot code passed the statement's examples, Copilot
also writes a brute force (it must pass the examples too) and three input generators: tiny (compared with the
brute force), medium (compared where the brute force finishes) and the largest input the constraints allow
(the candidate must finish in time). A difference or a timeout fails the code: one Copilot retry with the
counterexample, then Codex (S5). Used in code-eval S5 (`--no-stress` to compare) and in solveAdaptive's Copilot
stage (`ONBUD_STRESS=off`). Local only.

LCB dev S5: 26/30 · Codex 15 (today, without) → 27/30 · Codex 16 and 27/30 · Codex 18 (two runs, with).
On the three problems Copilot gets wrong while passing the examples: 3744 is caught (too slow on the largest
input); 3721 is not (the brute force is Copilot's too and shares the misreading: 18 random inputs agree); 3786
is inconclusive (the brute force fails the examples). So the gate removes slow solutions, but correlated errors
need an independent reference (a brute force from another model, or Codex for medium/hard contest tasks).
HumanEval/ML are not affected (not algorithmic: no stress test).

## 25. Code skill loop, round 2 (2026-11-07): what the stress gate really did, AFM reference, leakage rule, P7

**Correction to §24.** In both §24 stress runs the gate's verdict was never "fail". The extra Codex calls (and the
+1) came from Copilot's own hourly cap (120 requests): the last problems (3750, 3744, 3692) got no completion
and went to Codex. The cap is now visible (`copilotReq`/`copilotThrottled` per row) and configurable
(`ONBUD_COPILOT_PER_HOUR`; benchmarks ran at 600, 0 throttled).

**Brute-force source** (LCB dev, 10 easy + the 5 problems Copilot gets wrong; Copilot-only mode, no Codex):

| reference | real catches | false alarms | s / problem |
|---|---|---|---|
| AFM (`afmBrute`) | 0 — its brute force passed the examples on 6/14, never on medium/hard | 0 | 40 |
| Copilot, tiny inputs that vary order/ties/duplicates, worst-case large input | 3721 (fixed by the retry), 3744 (time limit) | 0 | 18 |
| both | 3744 | 2 (abc391_b, 3750) | 49 |

So the default stays Copilot; AFM is an option (`--stress-ref`, `ONBUD_STRESS_REF`). The time-limit test now runs
when no brute force exists (3744 had been missed by returning early).

**Leakage rule.** A candidate written after seeing a failing example's expected output has fitted the examples:
3 of 5 such candidates were wrong (HumanEval/126, LCB 3791, abc398_b). Such candidates, algorithmic or not, are
kept only on a stress-test pass; otherwise S5/S1 escalate.

**P7 on the code skill** (`tools/improve.ts --target code`, Codex in `--auto`): Codex wrote `solveCopilot()`, one
generation loop for S5 and solveAdaptive (first completion unchanged; a fresh sample with the failing example;
then one with an approach note from AFM; ≤ 10 inline requests). Copilot-only 52 → 53/81. Its agent edited the
main checkout through `afm_code`'s folder argument instead of its worktree; the brief now pins the worktree.

**Gate on AFM's code (S1).** AFM's code that passes the examples goes through the stress test on contest tasks;
a failure hands the counterexample to Copilot.

### All settings, code-eval 81 (HumanEval dev 30, LCB dev 30, ML 15, mlh 6)

| setting | before skills (11-01…11-06) | after (11-07) | Codex calls | API-eq. cost | time |
|---|---|---|---|---|---|
| Codex alone | 80 | – | 81 | $0.31 | 12.6 min |
| S1 (AFM → [Copilot] → Codex) | 77 · Codex 68 · $0.29 · 18.4 min | 76 · Codex 39 · $0.19 · 46.2 min | −43% | −34% | ×2.5 |
| S5 (Copilot writes → gate → Codex) | 73 · Codex 28 · $0.16 · 13.2 min | **76** · Codex 30 · $0.17 · 24.8 min | +2 | +7% | ×1.9 |
| Copilot alone | 52 | 53 | 0 | $0 | 12.3 min |
| S2 (AFM + local tools) | 20 | 25 | 0 | $0 | 50.3 min |
| S3 (S2 + Decima) | (= S2 in v4; ML 2/15) | 23 | 0 | $0 | 57.9 min |

Per set after: S5 HE 28 (6) · LCB 28 (18) · ML 14 (4) · mlh 6 (2); S1 HE 28 (12) · LCB 29 (20) · ML 14 (5) · mlh 5 (2).
S2/S3 code paths did not change (no Copilot, so no gate); their differences are AFM run-to-run variance.

- **S5 with the skill is the best cost/quality point:** 76/81 (Codex alone 80) with 37% of Codex alone's calls and
  55% of its API-equivalent cost. LCB 26 → 28: the gate sent 3721, 3744, 3791, arc194_d and 3692 to Codex. Still
  wrong: 3786 (no brute force passes the examples: inconclusive), arc191_a (Codex fails it too), and three
  HumanEval/ML function tasks Copilot gets wrong with no runnable examples or a weak one.
- **S1 with Copilot** cuts Codex calls by 43% for −1, but it is the slowest setting: AFM writes first, and 4 of its
  16 answers that passed the examples were wrong (all non-algorithmic, where no gate runs). AFM writing code is a
  net cost when Copilot is available — S5's design (AFM orchestrates, Copilot writes) is the better graph.
- **Speed:** S5 is ~2× slower than before (stress test: ~10 extra Copilot requests and ~20 s on contest tasks), and
  2× Codex alone's wall time; every Codex call it avoids is quota left for real work.

### The framework's own work (pre-skill 9d01be6 vs current; Codex calls 0 in every setting)

| | pre-skill | current |
|---|---|---|
| framework-eval S2 (56) | 52 · AFM 100 · 147 s | 52 · AFM 110 · 159 s |
| framework-eval S3 + web (56) | 54 · AFM 111 · 207 s | 54–55 · AFM 122 · 212–234 s |
| framework-eval S1 (56) | 53 · 221 s | 54 · 201 s |
| skill-eval (46 × 3, majority) | 20/46 · 3.96 AFM calls · 5.8 s per run | 46/46 · 2.81 · 5.4 s |

The skills' gains are in what the suites built for them measure (skill-eval, nine languages); framework-eval
stays level, and it never needed Codex.

## 26. Code skill as one graph; v0.2.0 measurement (2026-11-07)

- `services/controller/code-skill.ts` holds the code skill's graph (triage → write → check → gate → repair or
  escalate) for S5 (`solveCode`), S1 (`solveAdaptive`) and local jobs (`gateJobCode`); `stress_pass` is an
  implemented check; options in `config/skills.json` → `options.code`. The benchmark only maps flags.
- Lighter gate: no medium inputs, parallel runs at low concurrency, ~6 Copilot requests (was ~10); with a
  frontier available a failed gate escalates at once; inconclusive contest code escalates (default on);
  unverifiable code escalation is an option (off).
- Local jobs: Copilot steps on contest-style requests, and code written after a failed check, go through the
  gate; a file that does not load on its own is not gated.
- S5 on the 81 code tasks: 78/81 · Codex 33 · 17.7 min · $0.23 (round 2: 76 · 30 · 24.8 min).
- v0.1.0 (7a38390) against v0.2.0, same harness: framework eval S2 52 → 52, S3 + web 54 → 54, S1 55 → 53
  (E3 Copilot variance, 2/2 on rerun; G2 web); skill eval 19/44 → 44/44 (4.2 → 3.0 AFM calls, 5.9 → 5.2 s).
  Tables: docs/BENCHMARKS.md.

## 27. Escalation vs a pattern dictionary (2026-11-07, held-out LCB test split, 30 problems)

Measured on `lcb-v6-30` (never used to tune the code skill; the dictionary's examples were written from dev
failures). S5 v0.2.0 as the base; one run each unless noted (±1 task and ±$0.02 are run-to-run noise).

| setup | passed | Codex calls | cost | time | solved by Copilot |
|---|---|---|---|---|---|
| base (v0.2.0) | 29 | 23 | $0.170 | 14.9 min | 7 |
| A: plan-first escalation | 29 | 42 (on 22 tasks) | $0.290 | 20.9 min | 8 (+2 from Codex's plan) |
| B: public patterns (2 runs) | 28 · 29 | 18 · 19 | $0.150 · $0.182 | 15.3 · 16.6 min | 12 · 11 |
| B + private, unrelated (dev solutions, strict match) | 29 | 19 | $0.150 | 16.0 min | 11 |
| B + private, loose match | 29 | 20 | $0.176 | 15.5 min | 10 |
| A + B + private | 28 | 38 | $0.314 | 20.6 min | 11 |
| B + private incl. the same problems' own solutions (upper bound) | 29 | 20 | $0.155 | 14.9 min | 10 |

- **A fails.** Codex's cost is its reading and reasoning, not the code it prints: a plan costs about as much as
  the code, and Copilot implemented a hard plan in 2 of 22 cases, so most tasks paid twice. Off.
- **B (public) works:** Copilot solves 4-5 more problems on its own (easy 5 → 8, medium 2 → 3), Codex calls
  −17 to −22% at the same accuracy, +1 on-device call (~1 s) per contest task. Cost moves less (±): the calls
  left are the hardest ones. On by default (`options.code.patterns: "public"`), also in local jobs.
- **Private entries add nothing yet.** From unrelated problems they only help with a strict match (a loose one
  attached notes to 27/30 tasks and cost local solves). Even with each problem's own earlier solution in the
  notebook (the best case for "the user solved this before"), retrieval found it 22/30 times, examples failures
  fell 12 → 8, but those candidates then ended "inconclusive" at the gate and went to Codex. Two things limit
  it: tagging by the on-device model (it over-uses dp_1d) and the gate's inconclusive rule. Kept as an opt-in
  (`patterns: "all"`, `learn: true`); worth revisiting with a better retriever and a rule that trusts a
  candidate that matches a verified earlier solution.
- **Licensing:** the public dictionary is original text and skeletons (general algorithm knowledge, MIT). No
  benchmark statement or solution is in the repository. Private entries hold an on-device summary of the
  problem's shape and the frontier's code, which belongs to the user (OpenAI's terms assign output to the
  user); they stay in `runtime/state` (mode 600) and never leave the Mac.

### §27 final (2026-11-07): what ships in v0.2.0
- Ships: the gate (stress test, now also failing a crash on the worst-case input) and the public pattern
  dictionary with the v1 tagger. Not shipped: plan-first escalation, the private notebook (code removed), and a
  cue-shortlist tagger (v2: tuned on dev, it removed the dp_1d lean but gave 24 and 18 Codex calls on the
  held-out split against 18-20 for v1).
- Two dictionary skeletons mirrored dev problems (palindromic subsequence with k operations; grouping values by
  the number of divisions); replaced by generic ones before the final runs.
- The benchmark's Codex agent depended on the run tag; v0.2.0's first S5 run (tag v5) sent 6 of 33 calls through
  the heavier codex-handoff agent. Every setting now uses codex-solve.
- Final, held-out test subsets (95, the v0.1.0 problems): v0.2.0 74 · 36 Codex · $0.207 · 23.0 min; Codex alone
  76 · 95 · $0.392 · 15.6 min; v0.1.0 76 · 77 · $0.335 · 19.8 min. Development sets (81): 76 · 34 · $0.192 ·
  20.4 min. framework eval S1 53/56, skill eval 44/44.


## 28. Review of the v0.2.0 claims; one triage rule; same-day comparison (2026-11-08)

**What had been reported wrongly.** "v0.2.0 is better than v0.1.0 on every axis" came from the single best dev
run (78/81, 17.7 min; the same configuration also gave 76 at 24.8 min, and that run sent 6 of 33 calls through
the heavier agent). "v0.1.0 saved 8%, v0.2.0 26%" compared v0.1.0 on the test 95 with v0.2.0 on the dev 81, and
used an estimated Codex-alone cost. The 181-task total added the skill eval, which was written with v0.2.0's
skills. v0.1.0's test row was its Nov 1 run (the third use of the test subsets). Corrected: every comparison now
uses one set, the same days and the same agent, and shows v0.2.0's two runs.

**Changes.**
- One triage rule (`firstWriter` in code-skill.ts) for local jobs (controller) and the benchmark: Decima-hard,
  contest-style or unchecked new code would go to the frontier; with Copilot, checkable code is written locally
  first; `saver` also writes unchecked code Decima calls easy (the gate checks it); `balanced` sends it to the
  frontier. The skill options `escalateUnverified`, `trustBelow` and `codexFirstAt` are gone (the policy's
  `copilot_mode` and `decima_code_hard_threshold` decide). Default `copilot_mode: saver`, the measured setup.
- Unchecked code (no examples, no tests) goes through the gate too: a brute force on small inputs, no worst case
  (no constraints to build one); a disagreement escalates, inconclusive keeps. In local jobs: new code in a project
  with no test command.
- Contest code with a frontier behind it: two Copilot candidates, not three (the third kept 4 of 227 such tasks
  local, at ~10 s each, in the 2026-11-06/07 runs).
- Benchmark-only `ONBUD_STRESS` / `ONBUD_STRESS_REF` removed from the skill (bench flags remain).

**Same-day results** (cost at $2 / $0.10 / $10 per 1M input / cached / output):

| | test 95: passed · Codex · cost · time | dev 81 |
|---|---|---|
| v0.1.0 (7a38390, rerun 2026-11-07) | 76 · 77 · $0.355 · 16.7 min | 77 · 68 · $0.285 · 18.4 min (S1, 2026-11-06) |
| v0.2.0 before this change | 74 · 36 · $0.207 · 23.0 min | 76 · 34 · $0.192 · 20.3 min |
| **v0.2.0 (r3a, r3b)** | **75, 74 · 44, 42 · $0.257, $0.215 · 24.1, 22.1 min** | **79, 78 · 33, 34 · $0.180, $0.178 · 18.7, 17.9 min** |
| Codex alone | 76 · 95 · $0.392 · 15.6 min | 80 · 81 · $0.314 · ~13 min |

- Dev: +2–3 tasks and −2 min against the version before; test: same accuracy, +6–8 Codex calls (unchecked
  HumanEval code that disagreed with its brute force, and LCB noise), HumanEval 40/40 in both runs (was 39).
- BigCodeBench-Hard: the unchecked-code gate is mostly inconclusive (library and file tasks), so it adds Copilot
  time and little else; left as is (tuning it on the test split would be leakage).
- framework eval S1 53/56, skill eval 44/44 (3 runs), 191 tests.
- Leakage note: the two changes came from failure types seen on both splits (HumanEval/83 is a test problem); no
  setting was tuned on test numbers, but the test split has now informed design choices more than once.
- Verdict against v0.1.0 on the test 95: accuracy within noise (−1 to −2), Codex calls −44%, cost −34%, time
  ~1.4×. On dev: +1 to +2, calls −51%, cost −37%, same time. v0.2.0 stays; it is not faster.

## 29. Cheaper escalation; held-out set 2 (2026-11-08)

Goal: lower Codex cost and wall time at similar accuracy, tuned on the development sets only.
- Held-out set 2 (HumanEval 40, LCB v6 30, BCB-Hard stdlib 9; seed 20261108) was drawn from unused problems and
  committed (3752466) before any change below was measured.
- Dev 81: Sol at low reasoning first, then medium, plus one Copilot candidate for contest code: 81, 80 (before:
  79, 78), $0.16–0.19, 16–17 min. Low reasoning saves little per call: Codex cost is mostly output code.
- Dev 81, Terra first: 78, $0.10, 15 min (one valid run; the second hit the subscription limit). Chosen.
- Bugs fixed: an empty Codex answer counted as solved; OpenCode resolved the project from the parent's PWD and
  did not find new agents (`frontier-opencode.ts` sets PWD).
- Code frozen (0b65998), then held-out set 2 once per setup: v0.1.0 70 · 64 calls · $0.32 · 17 min; v0.2.0 67 ·
  34 · $0.17 · 20 min; Codex alone 71 · 79 · $0.32 · 12 min.
- Reading: cost halves; accuracy is 3–4 tasks lower, all HumanEval (two unchecked functions kept under `saver`,
  one example-passing Copilot error, one Codex error); time is higher because escalated problems pay for both
  tiers. No change was made from these results.
- Not yet: the cascade covers the code skill only; local jobs still escalate through `codex-handoff`.

## 30. A ladder of writers and a difficulty classifier (2026-11-08)

Why: §29's held-out result (67 vs v0.1.0's 70) came from two choices, not from the checks: saver mode kept
unchecked Copilot code, and Copilot tried every contest problem first (13 of 20 minutes went to problems that
ended at Codex anyway). Decima, asked whether a problem was hard, scored at chance (AUC 0.59).
- Classifier: on the dev logs Copilot solved 80% of easy contest problems and 2-6% of the others. Decima's
  question in four wordings: AUC 0.42-0.59; AFM's 1-5 rating: 0.65. A logistic regression over hashed words
  trained on CodeContests ratings (CC BY 4.0, read by range requests, ~5 MB; weights only, 35 KB): 0.86 dev LCB,
  0.92 old test LCB, 0.81 on "Copilot solved it". Threshold chosen on dev LCB. No Codex calls.
- Ladder: Copilot → Terra → Sol; Terra's answer kept on passing examples or, without examples, on agreeing with
  Copilot's code on generated inputs (the stress test with Terra's code as reference). copilot_mode back to
  balanced. codex-solve-low removed. Log replay on dev before any run: 79-81, ~15 min, $0.10-0.15.
- Order: held-out set 3 frozen (016b1f0) → one dev run of the ladder and of Terra alone → code frozen (08ab339)
  → set 3 once per setup.
- Dev 81: ladder 80 · 47 calls · $0.11 · 13 min; Terra alone 78 · $0.14 · 8 min.
- Set 3 (70): v0.1.0 58 · $0.19 · 29 min; ladder 66 · $0.09 · 13 min; Sol 67 · $0.26 · 10 min; Terra 65 ·
  $0.11 · 7 min.
- Limits: slower than either Codex alone (Copilot's 1.5 s spacing, attempts that end at Codex); 17% below
  Terra's cost is modest; the ladder covers the code skill, not a local job's whole-task hand-off; one run each.
- Prepared, not run: `codex-lead` (Codex delegates routine functions to Copilot through afm_code). Expected to
  matter only where Codex prints long code; benchmark answers are short and Codex's cost there is mostly
  reasoning.

## 31. Selectable tiers; the Server skill (2026-11-08)

- Tiers: the cheap agent is `codex-solve-cheap` (was `codex-solve-terra`): the name says the role, so a new model
  is a setting. Spotlight > Backend > Routing edits each tier's model and effort (strong: codex, codex-handoff,
  codex-solve; cheap: codex-solve-cheap) in the global OpenCode config, diff and backup first. Defaults stay
  Sol and Terra, so the measured setup (§30) is unchanged.
- Why a Server skill: on a remote IDE (VS Code Remote on a GPU server) OpenCode is not connected, so the
  ladder's savings are lost. OnBud stays on the Mac; only files, commands and logs cross over SSH. Fresh shows
  the same folder as an IDE (`fresh ssh://host/dir`: files, terminal and LSP on the server), or TTT / a shell /
  the job's tmux session over `ssh -t`. IDE-independent core, optional viewers started as external programs
  (Fresh is GPL-3.0, TTT MIT; neither is bundled, so OnBud stays MIT).
- Contract 1.2 adds capability and egress `remote` (they must go together; a private skill cannot have them).
- Safety: system `ssh` with BatchMode (no passwords or host keys answered by OnBud; keys and ~/.ssh contents
  never opened; only `Host` names are read); the upload list is built locally (git-tracked and untracked
  non-ignored files, minus secrets, rebuilt folders and files over 50 MB) and shown before the yes; the remote
  command passes the local security gate; nothing remote is deleted; one servers.json entry may be the default,
  ssh_config aliases must be named.
- Jobs: tmux when the server has it (the user can attach and take over), else nohup; `sbatch` goes to Slurm.
  State, exit code and log tail on request; `.onbud/STATUS.md` and `jobs.md` in the remote folder make the job
  visible in the IDE's file tree. Codex reads jobs through the `server_jobs` MCP tool (read-only).
- Tested without a server: a fake ssh runs the remote side in a temporary home (upload, run, status, pull, the
  gate, exit codes; tmux checked by hand). Not yet run against a real server; Fresh's daemon `open-file` (to open
  a log at a line in a running Fresh) is a later step.


## 32. Everyday requests from Spotlight (2026-11-10)

The user reported three failures: "설정 앱의 vpn 항목 열어줘" answered `Settings/VPN`, while "Open the settings app." worked. "Let me know the time when the Codex token is reset." was answered from an unrelated letter on the Desktop.

**Probe.** 40 everyday requests were run under Spotlight's conditions: root ~/Desktop, memory off. Act mode was used except for app launches and personal data (calendar, clipboard). The scripts were not committed.

Failures before the fix:

| Area | Requests and what went wrong |
|---|---|
| Arithmetic and units | 17% of 2,340 → 341.2; 3시간 45분 → 265분; 2^20 → 4,294,967,296; 100°F → 212 |
| Clock | "지금 몇 시" escalated; the weekday was guessed |
| General questions | Answered from unrelated Desktop files. "Who wrote Pride and Prejudice?" → Moby-Dick |
| Translation | "Translate 'thank you for your help'…" showed the help table |
| Writing | "Write a short polite email…" was read as the shell command `write` |
| Shortcuts | "강제 종료 단축키" → ⌘Z |
| Copilot | "How many Copilot requests do I have left?" was sent to Copilot chat |

**Fixes.** All are code; no model was tuned.

- **`quick_answer` (mac skill):** answers by code, with no model call:
  - clock and date, days until or after a date
  - arithmetic (a safe parser), percent of, discount, percent change
  - unit conversions: length, mass, temperature, volume, area (평), speed, data, time
  - macOS shortcuts (a fixed table)
  - this Mac's local IP
- **Settings panes:** System Settings panes open through `x-apple.systempreferences:<id>`. There are 36 panes; ids were checked against /System/Library/ExtensionKit on macOS 27.2. A Wi-Fi password request opens the Wi-Fi pane and points to Copy Password; the Keychain is never read.
- **Codex usage:** read from the Codex CLI's own `~/.codex/sessions` token_count events (rate_limits only; auth files are never opened). The answer says when the values were logged.
- **General questions:** a general question asked from a personal folder (home, Desktop, Documents, Downloads, or any folder without git or project files) is answered as chat. The folder is not read and triage is skipped (about 1 s saved). It uses its own prompt with a fixed reply language and gives the full text for writing requests.
- **Short translation:** a quoted text plus a target language gets one call and a script check.
- **Routing fixes:**
  - Help words inside quotes are ignored.
  - An English sentence is not a typed command.
  - A how-to never runs mac_control.
  - Copilot questions with "left / how many" read usage.
  - "OnBud로 뭘 할 수 있어" opens help.
- **File-type lists:** a list request that names a file type ("Desktop에 있는 PDF 목록") lists only that type, with names and metadata and no per-file description ("문서 나열해줘" still describes each file). Time went from 65 s to 14 s on the first run and 14 ms from the cache.

**After.** Same probe, final run:

| Area | Result |
|---|---|
| Quick answers | 15/15 correct (clock, arithmetic, units, shortcuts, IP); 1–20 ms each instead of 3–6 s |
| Codex and Copilot usage | Correct |
| General questions | 3–4.5 s, no files read. Correct: Austen, Canberra, Seoul, HTTP 404, DNS, recursion |
| Translations | Japanese and English, about 0.5 s |
| Live data | "Will it rain tomorrow?" says live data is needed |

Still weak: AFM's short writing. The Slack message was one sentence, and the subject-line suggestion repeated its input. These are left for the writing skill or Copilot.

Tests: everyday.test.ts (9 tests); skill eval cases in mac (+6) and core (+3).

## 33. The LaTeX file named by path (2026-11-11)

**Report.** "Please compile the tex file into pdf in the following directory: ~/Downloads/…/proposal_v4.tex" was asked from Spotlight, whose root is ~/Desktop. It compiled another project's `main.tex` on the Desktop instead. It also listed about 70 "duplicate labels".

**Cause.**
- Paths are only matched inside the open folder, so the absolute path was not seen.
- `findMainTex` then preferred any `main.tex` under the Desktop.
- `checkReferences` read every .tex under the root: all the papers on the Desktop at once.

**Fix.**
- A .tex named by an absolute or ~/ path (`namedTexPath`, inside home only) is the target, with its folder as the LaTeX root. A path that does not exist is reported, not replaced by another file.
- In a personal folder with several LaTeX documents and none named, OnBud asks which one.
- References are checked over the document's own files only: main plus what it \input/\include/\subfile's, and the .bib files it names (`documentFiles`). The MCP `latex_check` does the same.
- No edit proposal is made for a file outside the open folder, because proposals are applied relative to it.

**Result.** The same request now compiles proposal_v4.tex in 2.1 s. tests/latex-target.test.ts was added; npm test 213/213.

## 34. A path in the request is where every skill works (2026-11-11)

**Problem.** Folder mix-ups kept coming back. Spotlight opens ~/Desktop, but until now only the convert skill and the LaTeX compile looked at a file named by path outside the open folder. Every other skill read the Desktop or answered from another file.

**Rule** (`services/context-builder/explicit-paths.ts`, applied in the controller before any skill runs):
- **Work folder:** a file or folder named by an absolute or ~/ path becomes the work folder: a file's own folder, or the common folder of several paths. Named files are passed to the skill as if they were in the open folder.
- **Path matching:**
  - Paths may contain spaces; the longest existing prefix of the next words is used.
  - Korean particles ("…scores.csv에서") and quotes are handled.
- **Privacy:**
  - Paths must be inside home (or /Volumes).
  - Hidden folders (~/.ssh, ~/.aws, …) are never used.
  - Every file passes the security gate, so keys, .pem, .env and credentials stay closed. Such a path gets a plain refusal (`path_blocked`).
- **Missing files:** a file path that does not exist is reported (`path_not_found`), not replaced by another file.
- **Approvals:** a pending command, edit, job or hand-off is stored with the moved folder (`Outcome.workRoot`), so the approval runs where the work was done. csv_json now writes absolute paths into its command.
- **Server skill:** its remote paths are excluded.

Also fixed on the way:
- translate took the source language as the target ("영어에서 한국어로" → English); it now uses the language marked by 로/으로/into/to.
- translate rejects output that echoes the prompt or schema.

**Probe.** Spotlight root ~/Desktop, files in a folder outside it, one with spaces. All of these found and used the named file:
- summary
- action-item table
- CSV lookup
- error triage
- translation
- folder listing
- CSV → JSON (approval command with absolute paths)
- privacy scan

A missing file and ~/.ssh/config were refused plainly. Tests: tests/explicit-paths.test.ts; npm test 216/216; skill eval 55/55.

## 35. Do, don't describe: Mac actions in plain English (2026-11-13)

**Report.** "Open the setting app and show bluetooth setting" was answered with how-to text instead of opening the pane.

**Probe.** English action requests run end to end with `ONBUD_DRY_ACTIONS=1`. This new switch reports app, Finder, pane and terminal openings without doing them. Approval actions only propose a command, so nothing ran.

**Why it kept happening.**
1. **Brittle wording rules.** Each skill fires on a hand-written pattern for one wording. Polite forms ("Could you open Notes for me?"), compound requests ("Open Calendar app and show today"), singular nouns ("setting") and other verbs ("pull up", "start Spotify") missed.
2. **Router picks were dropped.** The Decima router often picked the right skill, but the skill's own parser then could not extract the target, so the pick was dropped ("does not apply").
3. **The fallback can only describe.** The last stop is AFM's answer prompt, which cannot act, so it writes instructions. Sometimes it claimed the action was impossible.
4. **Missing actions:** volume up/down, brightness, lock, Wi-Fi/Bluetooth power, Trash, hidden files, quit an app, a folder in Finder. "Make it louder" was even read as the shell command `make`.

**Fix (skills plus one loop step).**
- **`plainRequest`:** strips politeness and padding before the rules. `launchTarget` takes the first clause of a compound request, "get X running", "pop open", and start/run for an app installed under that exact name.
- **Settings:** singular setting/preference and more verbs (see, pull up, get me, I want the …). Distinctive pane names work without the word "settings" (Login Items, Wallpaper, VPN, …). "check for macOS updates" opens Software Update.
- **New `mac_control` actions, all behind approval:**
  - relative and min/max volume, silence
  - brightness keys
  - lock screen
  - Wi-Fi power (networksetup)
  - Bluetooth power: blueutil if installed, else the Bluetooth pane
  - empty the Trash, flagged "cannot be undone"
  - Finder's ⇧⌘. hidden-files toggle (`defaults write` + `killall` is refused by the gate)
  - quit an app; a quit request for an app that is not installed says so

  Finder folders open from `launch_app`.
- **Step 1f, action picker:**
  - **When it runs:** for an imperative request, or a short request that mentions a Mac noun. Questions and developer work are left out.
  - **What AFM does:** picks one action from a closed enum with a target, and never acts itself.
  - **What code does:** checks the pick (appearance vs brightness; a pane named in the request), writes the canonical request, and runs the skill with its usual checks and approval.
  - **If the action can't be done:** the answer prompt must say so plainly and never claim it was done.
- Document-word matching uses word boundaries ("wallpaper" is not "paper").

**Measured** (dry run; nothing is opened or run):

| Set | Requests | Acted correctly | Notes |
|---|---|---|---|
| 1, before | 45 | 28 | 17 answered with text |
| 1, after | 45 | 45 | tuned on this set |
| 2 | 30 | 30 | tuned on this set after a 19/30 first run |
| 3, fresh | 25 | 17 | 1 wrong action: "turn down the brightness" lowered the volume |
| 4, fresh | 25 | 22 | no text answers left except one |
| 5, fresh | 20 | 18 | 0 text answers; 2 imprecise picks, fixed by the code checks |

Each fresh set was run once before any change.

**Cost:** rule hits take 1–80 ms; a picker hit takes about 1.5 s (one AFM call).

**Remaining:** the picker can still choose a near action. Approval actions show the command first, so a wrong pick is visible before anything runs. Pane and app openings are immediate but harmless.

Tests: tests/mac-actions.test.ts (6 tests); mac eval +4 approval cases; npm test 222/222; skill eval 59/59.

## 36. Beyond the listed actions: recipes, AFM-written commands, the Shortcuts Gallery (2026-11-13)

**Request.** Actions outside the fixed list should still be done locally, with AFM, instead of "I can't do that yet". A missing shortcut should come from the Gallery.

**Can AFM do it alone?** Tested directly: AFM wrote one command for each of 20 open-ended requests.

| Result | Count | Examples |
|---|---|---|
| Correct | 5 | |
| Did not compile (AppleScript) | 10 | |
| Compiled but did something else | 5 | `caffeinate -t 1h`; `open -a Safari -url`; "what's playing" → play a track; "remind me at 5pm" → set the system date |

Free-form commands alone are not safe enough to run.

**Design** (`services/controller/mac-recipes.ts`; controller step 1f now runs before the router):
1. **One AFM pick** over the fixed actions and about 30 vetted recipes, or none. A near action counts as wrong.
2. **Recipes.** AFM fills only that recipe's slots in a second call where every slot is required.
   - Code checks the values: email and URL must appear in the request; folders stay inside home with no `..` or hidden parts; lengths are bounded; clock times and hours are converted by code.
   - Code builds the command.
   - Harmless recipes run at once: say, notify, open URL, music controls, mail draft, clipboard copy, keep awake, timer, and read-only lookups (uptime, battery, front and open apps, memory, folder size, file search).
   - Recipes that create something ask first: note, reminder, folder, eject, display sleep.
3. **Code checks on near picks:** skip → next track; size vs count; display vs appearance; an app that is not installed is not a launch.
4. **None of the above → AFM writes one command.**
   - Code runs `bash -n`, compiles each AppleScript with osacompile (one retry with the error), and applies the command gate.
   - A read-only command runs at once.
   - Anything else is shown as "AFM-written, not verified" and needs approval.
   - A denied command is refused with the reason.
5. **Shortcuts.** There is no API to download Gallery shortcuts. A missing shortcut ("run my Pomodoro shortcut", "get the Water Reminder shortcut") opens `shortcuts://gallery/search?query=…`, so adding it is one click in the Shortcuts app. Similar shortcuts the user already has are listed, along with what OnBud does itself (convert, timer, reminder, screenshot, Wi-Fi). No app-control permission is needed (shortcuts CLI and URL).
6. **After approval,** a Mac-action command shows its result; the request is no longer handled again. Before, approving dark mode proposed it again.

**Measured** (dry run; harmless recipes also run for real: notification, uptime, battery, folder size, music state):

| Set | Requests | Result |
|---|---|---|
| Set A, first run | 20 | 18/20 mapped |
| Set B, end to end | 20 | 15/20 → 20/20 after fixes |
| Fresh set C, run once | 20 | 12/20 acted |
| Fresh set D, run once | 20 | 13/20 acted |
| Fresh set E, run once | 15 | 13/15 acted; 1 wrong value ("alarm for 7:30am" → 45 min, now computed by code) |

The remaining misses are requests that never reached the action step: earlier rules or a narrow gate. The gate now also sends short requests that name a time, an app or a Mac thing to the picker.

**Limits:**
- macOS hides the Wi-Fi name (`<redacted>`) from command-line tools without Location access; the recipe says so.
- The front-app and open-apps recipes use System Events, which asks for Automation permission the first time.

Tests: tests/mac-recipes.test.ts (5): every recipe compiles and passes the gate, slot checks, times. npm test 227/227; skill eval 61/61.
