# OnBud 0.2.0

Everything since 0.1.0 (2026-11-02). Apple silicon, macOS 26 or later, Apple Intelligence on.

## Highlights
- **New name: OnBud** — *Spotlight-Style Local On-Device Framework for macOS*. Same project, same purpose; v0.1.0
  was published as OpenAFM. New app icon and banner. The app, cask, data folder (`~/OnBud`), environment
  variables (`ONBUD_*`), LaunchAgents (`dev.onbud.*`) and repository (`P-YI/OnBud`) carry the new name; an
  existing installation is carried over (see [Upgrade](#upgrade)).
- **GitHub Copilot writes code, Codex takes the hard cases.** With the new Copilot plugin (its inline completion
  through GitHub's official language server; unlimited on Copilot Pro, Pro+ and Student, 2,000 a month on Free), the on-device model plans and
  checks, Copilot writes, and Codex is called only for what fails the checks. On the held-out code
  benchmark (70 problems, frozen before the code it measures): 66 passed with Codex cost $0.09, against
  v0.1.0's 58 at $0.19 in less than half its time, and within one task of Codex alone at a third of Sol's cost.
- **Skills.** Everything OnBud does is now one of 13 skill packs with a contract: what it may do
  (read, propose, run approved, write new files, network, frontier), what leaves the Mac, the checks that make
  an answer green, and a switch in the new Skills window. A skill eval gates every change.
- **Answers in your language.** Nine languages (ko, en, ja, zh, es, fr, de, pt, it): the reply follows the
  request, with code, paths, numbers, tables and names kept exactly.
- **New everyday skills:** file conversion (images, PDF pages, merges), Shortcuts (list, run after approval,
  install from a catalog), Mac controls (dark/light mode, volume, mute, screenshot; changes ask first;
  clipboard text on request, secrets masked), browser tab (the front Safari or Chrome tab), and
  calendar/reminders (read-only, off by default).
- **Remote servers (new `server` skill and plugin).** Run experiments on your GPU server or Slurm cluster over
  your own SSH while the code is still written on the Mac (so the Copilot → cheap → strong ladder still applies):
  upload the project (secrets and big files left out) and start a command after your yes, read job state and
  logs, and watch the server in a terminal IDE: Fresh on the Mac (`fresh ssh://host/dir`) or TTT, a shell, the
  job's tmux session or its log on the server. OnBud never reads SSH keys; Fresh and TTT are not bundled.
  Known limits: the skill is tested with a fake `ssh` (upload, run, status, pull, gate, exit codes) and checked
  once against a real server (check, upload, tmux run, status, pull), so broader use may still find gaps; an approved run is subject to the controller's 120 s command limit, so
  start very large uploads with `afm-server run` in a terminal.

## Code
- **Copilot tier** (Backend > GitHub Copilot; sign in once): local code jobs and the `afm_code`
  MCP tool use Copilot's completion; requests are editor-like (at least 1.5 s apart, at most 120 an hour).
  `copilot_mode` in `policies/routing.yaml`: `balanced` (default, the measured setup) or `saver` (Copilot first
  for all checkable code; fewer Codex calls, slower, less accurate).
- **A ladder of writers:** Copilot (free) → Codex's cheap tier (default GPT-6.1 Terra, agent `codex-solve-cheap`) →
  its strong tier (default Sol). Both tiers' models are chosen in Spotlight > Backend > Routing (Frontier: Strong / Cheap). Each
  answer must pass a check (examples, stress test, or agreement with Copilot's code on generated inputs) before
  it is kept; a failed check moves the task one rung up. Contest-style code starts at Copilot only when a bundled
  difficulty classifier (`skills/code/difficulty.json`, 35 KB, trained on DeepMind CodeContests ratings, CC BY
  4.0) calls it easy. The ladder is in the code skill (benchmarks and code-skill callers); a local job that
  escalates still hands the whole task to Codex (Sol).
- **Stress test gate** (`stress_pass`, the code skill's check): contest-style code, and any code written after
  it saw a failing example, must agree with a brute force on random inputs and finish on the worst-case input;
  code that nothing else checks (no examples, no tests) must agree with a brute force on small inputs.
  Code it cannot judge, or that fails, goes to Codex; offline, the best local code is kept and marked.
  Options in `config/skills.json` → `options.code`.
- A code step must define the functions the request names (Copilot gets their signatures); a retried
  candidate is not trusted on the examples it was shown.
- Approach notes: a dictionary of 24 algorithm patterns (`skills/code/patterns.json`, written for OnBud);
  the on-device model picks up to two for contest-style code and they go above Copilot's code as comments.
  Copilot solves more of these problems itself, so fewer go to Codex.
- Contest code gets one Copilot candidate before Codex (agents `codex-solve-cheap`, `codex-solve`).
- One code graph (`services/controller/code-skill.ts`) for benchmarks, local jobs and the MCP tool.

## Skills, routing and memory
- Contracts and a registry (`skills/<id>/skill.json`, contract 1.2: capability and egress `remote` for the user's own server): one owner per reason code; third-party
  skills read or propose only; private skills never leave the Mac.
- Router: for requests no rule claims, the on-device model picks a skill from its example requests, or none;
  it never starts a skill that writes files, and how-to questions never run an acting skill.
- Work graphs: independent steps run together, a failed unit is retried at most three times, dependents are
  skipped; every local job writes `graph.json`.
- Strategy memory: plans and their verdicts per skill (generalised, last 25), recalled as "what worked / what
  failed" for similar requests; kept apart from conversation memory.
- Improvement runner (`tools/improve.ts`): reads the latest eval, writes a scoped brief, and (only with
  `--run --yes-spend-codex`) lets Codex try a fix in a separate worktree, then runs the gates.
- File search by topic ("the PDF about attention heads"): Spotlight titles and contents, and how each result
  matched.

## Launcher
- Skills window (menu bar > Skills…): what each skill does, its permissions, what leaves the Mac, the plugins
  it uses, its switch; Calendar & Reminders asks before it turns on.
- Ghostty support (setup, plugin installs and hand-offs open in Ghostty when it is the terminal).
- Answers and questions selectable and copyable; ⌘X/C/V/A/Z in every window.
- Ollaya and SearXNG start on demand (Start/Stop in Backend); starting at login is optional.
- Routing tiers in Backend, with a model picker for each frontier tier (strong: hand-offs; cheap: the code
  skill's checked first escalation); Send to Codex for OpenCode 2.
- Remote server plugin (Settings > Plugins): installs Fresh with Homebrew on request; counts the servers it can name.
- Widget extension starts again (it crashed on launch in 0.1.0).

## Removed from the repository
- The v0.1 experiments that no longer describe OnBud: the BFCL tool-calling eval, the open-model GPU kit
  (`tools/bench/server`), the Terminal-Bench-style mini suite and a document A/B script. The open-model
  comparison stays on the benchmarks page; the other numbers are in the v0.1.0 release.

## Privacy and safety
- Benchmark questions about real documents load only from `~/OnBud/runtime/evals/private` (never in the
  repository); test fixtures use fictional names.
- Generated code runs only in a sandbox (no network, writes only to temp folders), at low concurrency.
- Copilot sends the code it completes to GitHub: the code skill is marked egress `capsule`, and the plugin is
  off until you sign in. `ONBUD_COPILOT=off` turns it off.

## Measured (details: docs/BENCHMARKS.md)
Code on held-out set 3 (70 problems: HumanEval 40, LiveCodeBench v6 30), drawn and frozen before the ladder was
measured, run once per setup on the same day:

| | v0.1.0 | v0.2.0 | Codex alone (Sol) | Codex alone (Terra) |
|---|---|---|---|---|
| Passed | 58 | **66** | 67 | 65 |
| Codex calls | 45 | **41** | 70 | 70 |
| Cost (API-equivalent) | $0.19 | **$0.09** | $0.26 | $0.11 |
| Time | 29 min | 13 min | 10 min | 7 min |

Against v0.1.0: 8 tasks more, cost −50%, time −56%. Against Codex alone: within one task, cost −64% (Sol) and
−17% (Terra), slower (Copilot is paced like an editor). On the development sets (81) v0.2.0 passed 80 with $0.11
of Codex in 13 min (v0.1.0: 77, $0.29, 18 min; Terra alone 78, $0.14, 8 min). Everyday work 53/56 and skills
46/46 with no Codex calls (v0.1.0: 55, and 19 of the 44 cases before the server skill; the skill eval covers
skills v0.1.0 did not have).

## Upgrade
New install: see the README. Copilot is optional: Backend > GitHub Copilot.

From 0.1.0 (then called OpenAFM):
1. Replace the app. Homebrew:
   ```bash
   brew uninstall --cask openafm && brew untap p-yi/openafm
   brew tap p-yi/onbud https://github.com/P-YI/OnBud && brew trust --cask p-yi/onbud/onbud && brew install --cask p-yi/onbud/onbud
   ```
   (`brew upgrade` on the old tap also follows the rename.) DMG: drag OnBud to Applications.
2. Open OnBud. On first launch it makes `~/OnBud` a link to your existing `~/OpenAFM` (nothing is moved), moves
   chat history to `~/Library/Application Support/OnBud`, copies your settings, and offers to move
   `OpenAFM.app` to the Trash.
3. Settings > Backend > **Update…** (or **Run setup…**) copies the new controller and reinstalls the LaunchAgents as `dev.onbud.apfel` and
   `dev.onbud.agent` (the old `dev.openafm.*` ones are removed).
4. If you set environment variables, rename `OPENAFM_*` to `ONBUD_*` (for example `ONBUD_COPILOT=off`).
   OpenCode users: Settings > OpenCode config (**Check OpenCode config**, then apply) replaces the `openafm` MCP entry with `onbud` (tools are now
   `onbud_*`). Job folders on remote servers are now `.onbud/`.

## License
MIT. Third-party notices: THIRD_PARTY_NOTICES.md.
