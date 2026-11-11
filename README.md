<p align="center">
  <img src="docs/assets/OnBud_banner.png" alt="OnBud — Spotlight-Style Local On-Device Framework for macOS" width="100%">
</p>

<h3 align="center">Apple's on-device model, put to work on your own files.</h3>

<p align="center">
  <a href="https://github.com/P-YI/OnBud/releases"><img src="https://img.shields.io/badge/version-0.2.3-blue" alt="Version 0.2.3"></a>
  <a href="https://developer.apple.com/macos/"><img src="https://img.shields.io/badge/macOS-26%20Tahoe%2B-000000?logo=apple&logoColor=white" alt="macOS 26 Tahoe+"></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/Apple%20silicon-M1%2B-555555?logo=apple&logoColor=white" alt="Apple silicon"></a>
  <a href="https://swift.org"><img src="https://img.shields.io/badge/Swift-6-F05138?logo=swift&logoColor=white" alt="Swift"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-22.6%2B-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 22.6+"></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/Xcode-not%20required%20(Command%20Line%20Tools)-orange" alt="Xcode not required: the Command Line Tools come with Homebrew"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://developer.apple.com/documentation/foundationmodels"><img src="https://img.shields.io/badge/inference-on--device%20by%20default-green" alt="On-device by default"></a>
  <a href="#install"><img src="https://img.shields.io/badge/Homebrew-tap-FBB040?logo=homebrew&logoColor=white" alt="Homebrew tap"></a>
  <a href="https://github.com/Arthur-Ficial/apfel"><img src="docs/assets/powered-by-apfel.svg" alt="Powered by apfel" height="20"></a>
</p>

<p align="center">
  <a href="#contributing"><img src="https://img.shields.io/badge/%23agentswelcome-PRs%20welcome-0066cc?style=for-the-badge&labelColor=0d1117&logo=probot&logoColor=white" alt="PRs welcome"></a>
</p>

Every Apple silicon Mac with Apple Intelligence has a ~3B language model built in. On its own it is a good
reader and a weak programmer. **OnBud** wraps it in code that does the searching, reading, running and
checking, and asks you before anything changes. Press **⌥ Space**, ask about a folder, a paper, a
spreadsheet or your git changes, and approve or deny each command and edit. Answers are computed on your Mac;
nothing leaves it unless you turn on a plugin that says so.

| | What you get |
|---|---|
| **Launcher** | A Spotlight-style panel (⌥ Space), chat widget, menu-bar activity light, Services menu "Ask OnBud" |
| **Local agent** | 13 skill packs with contracts and switches, document reading with OCR, commands and edits behind approvals, LaTeX, local jobs, replies in nine languages |
| **Plugins** | Router model (Ollaya + Decima), GitHub Copilot (writes code), Codex via OpenCode, web search (SearXNG), LaTeX (MacTeX), translation languages — each installed from its own project when you need it |
| **OpenCode** | The same controller as an OpenCode agent (`afm`) and an MCP server for frontier agents |

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
    <img src="docs/assets/architecture-light.svg" alt="OnBud architecture" width="100%">
  </picture>
</p>

> [!NOTE]
> **OnBud is an independent open-source project.** It is not made, endorsed, sponsored or supported by Apple
> Inc. It uses Apple's public FoundationModels framework through [apfel](https://github.com/Arthur-Ficial/apfel),
> like any third-party app. Apple, Apple Intelligence, macOS and Spotlight are trademarks of Apple Inc.

## Requirements

- Apple silicon Mac (M1 or later), **macOS 26 Tahoe or later**
- **Apple Intelligence** turned on (System Settings > Apple Intelligence & Siri)
- [apfel](https://github.com/Arthur-Ficial/apfel) and Node.js 22.6+ — setup installs them with Homebrew if they are missing
- **No Xcode.** Apple's Command Line Tools (git, python3, swiftc) are enough; Homebrew installs them with
  itself. OnBud uses `swiftc` only to build its small helpers on first use if they are missing.

Optional, for single features (install them when you want the feature):

| Feature | Needs |
|---|---|
| GitHub status (read-only: PRs, issues, CI) | [`gh`](https://cli.github.com) and `gh auth login` |
| Long-running commands in background sessions | [`tmux`](https://github.com/tmux/tmux) (`brew install tmux`) |
| Faster code search | [`ripgrep`](https://github.com/BurntSushi/ripgrep) (`brew install ripgrep`; else `git grep`) |
| Router model, Codex, web search, LaTeX, translation | the matching plugin in Settings > Plugins (see [Plugins](#plugins)) |
| Code written by GitHub Copilot | a Copilot plan and Backend > GitHub Copilot (see [GitHub Copilot](#github-copilot-optional)) |

## Install

**Homebrew** (also installs apfel and Node.js):

```bash
brew tap p-yi/onbud https://github.com/P-YI/OnBud
brew trust --cask p-yi/onbud/onbud      # Homebrew 7+: allow this one third-party cask
brew install --cask p-yi/onbud/onbud
```

**DMG:** download `OnBud-0.2.3.dmg` from [Releases](https://github.com/P-YI/OnBud/releases) and drag
OnBud to Applications.

> [!NOTE]
> OnBud is not signed with a Developer ID or notarized. The first launch is blocked with "Apple could not
> verify…". Open **System Settings > Privacy & Security** and click **Open Anyway**, or run
> `xattr -dr com.apple.quarantine /Applications/OnBud.app`.

Then open OnBud and click **Set up OnBud…**. Terminal opens and, asking before each step:

1. checks the Mac (Apple silicon, macOS 26+);
2. installs what is missing from each project's own source: Homebrew, `brew install apfel`, `brew install node`;
3. copies the controller to `~/OnBud/adaptive-coding-agent`;
4. starts apfel (`127.0.0.1:11434`) and the controller (`127.0.0.1:11435`) at login.

Update: `brew upgrade --cask onbud` (or a newer DMG), then Settings > Backend > **Update…**.

## Quick start

Press **⌥ Space** and type, or click a quick action:

```text
describe the documents in this folder
paper.pdf: which venue was it published at, and what is the main result?
summarize the uncommitted changes          → a table of changed files
write a commit message for my changes
compile the paper and fix errors           → latexmk, log summary, proposed fixes
Run `npm test`                             → waits for your "yes"
src/stats.py의 mean 함수가 평균을 잘못 계산해. 고쳐줘   → sandbox trial + tests, then "apply?"
show commands                              → everything it can do
```

Drop files on the panel, paste from the clipboard, or select text in any app > Services > **Ask OnBud**.
`onbud://ask?q=…&folder=…` opens the panel from Shortcuts, Raycast or scripts.

## Skills

Everything OnBud does belongs to one of 13 skill packs (`skills/<id>/skill.json`). Each pack declares what it
may do and what may leave the Mac; a skill eval checks every change against those contracts. Menu bar ›
**Skills…** shows each one with its permissions, the plugins it uses and its switch.

| Skill | What it does | May | Leaves the Mac | Uses |
|---|---|---|---|---|
| core | triage, routing, the final answer and its citation checks, memory, the escalation decision | read, propose | nothing | Router model (optional) |
| files | find files by name, topic or content; answer questions about PDFs (with OCR), Word, slides, sheets, iWork, HWPX, images | read, propose | nothing | Spotlight |
| code | edits tried in a sandbox with your tests, local code jobs on their own branch, docstrings, error triage, renames | read, propose, local jobs | code being completed (Copilot) or a redacted task (Codex), only when those are on | GitHub Copilot, Codex |
| git | repository state, change summaries, commit messages, release notes, PRs and checks (read-only), local jobs | read, propose, local jobs | GitHub API queries | git, `gh` |
| writing | LaTeX compile, error fixes, citation and reference checks, CSV → tables; short drafts; translation | read, propose | nothing | LaTeX, Translation languages |
| mac | open apps, terminals, editors and System Settings panes; Mac health; dark mode, volume, screenshot; quick answers by code (time and dates, arithmetic, units, macOS shortcuts); commands you approve | read, propose, run after approval | nothing | your terminal / editor / browser |
| security | secrets in the project and shell history, credential files, open ports; privacy scan of documents (masked) | read | nothing | – |
| web | web search after you approve the query; the pages read are cited | read, network | the approved query | Web search (SearXNG) |
| frontier | hand-offs you approve: Codex (read-only answer or its own worktree session), Copilot chat | read, cloud model | a redacted task capsule | Codex via OpenCode |
| server | your GPU server or Slurm cluster over your own SSH: upload the project and run a command after approval, job state and logs, open the server in a terminal IDE | read, propose, run after approval, your server | project files (no secrets, nothing over 50 MB) and the approved command, to your server | Remote server (Fresh/TTT) |
| convert | images (format, size, smaller files), PDF pages and merges, documents, zip — always into new files | read, write new files | nothing | macOS (sips, PDFKit, textutil) |
| shortcuts | list your Shortcuts, run one after approval, install from a vetted catalog | read, propose, run after approval | nothing | Shortcuts |
| personal | Calendar events and Reminders, read-only — **off by default** | read | nothing (never stored, logged or handed off) | macOS Calendars / Reminders access |

Name a file or folder by its path (absolute or `~/`, spaces allowed) and every skill works there, even when
another folder is open; paths stay inside your home folder, hidden folders and secrets (keys, `.env`) are never
read. Commands, edits, web queries, jobs and hand-offs always wait for your "yes"; irreversible actions (send, delete,
pay) are never automatic. Answers follow the request's language (nine languages). Details:
[docs/OVERVIEW.md](docs/OVERVIEW.md) · launcher: [apps/spotlight/README.md](apps/spotlight/README.md).

## Plugins

Settings > Plugins (GitHub Copilot: Backend > GitHub Copilot). Each one says what it downloads and opens
Terminal with the exact commands; nothing installs in the background. Ollaya and SearXNG start only when you
click **Start** in Backend (starting at login is an option).

| Plugin | Adds | From |
|---|---|---|
| Router model | "AFM + Decima": a 321M local model advises the router | [Ollaya](https://github.com/ollaya-dev/ollaya) + [Decima](https://ollaya.dev/library/decima) |
| GitHub Copilot | Copilot's inline completion writes code; the on-device model plans and checks it | [copilot-language-server](https://www.npmjs.com/package/@github/copilot-language-server) (MIT) |
| Codex via OpenCode | hand big tasks to Codex; "Review with Codex" for local jobs; pick the Strong and Cheap models and their reasoning effort in Backend > Routing (defaults Sol / Terra) | [OpenCode](https://opencode.ai) |
| Web search | approval-gated web search; a private local search engine if installed | [SearXNG](https://github.com/searxng/searxng) (else DuckDuckGo Lite, arXiv, Wikipedia) |
| LaTeX | compile papers and fix errors | [MacTeX](https://www.tug.org/mactex/) |
| Translation languages | offline translation packs for the translator | Apple's Translation framework |
| Remote server | run experiments on your server; watch it in a terminal IDE | your `ssh`; [Fresh](https://github.com/sinelaw/fresh) (GPL-3.0) on the Mac or [TTT](https://github.com/eugenioenko/ttt) (MIT) on the server, installed separately |

### Remote servers and terminal IDEs (optional)

When you develop on a GPU server, an IDE running there (VS Code Remote, say) has no OpenCode, so the cost-saving
ladder (Copilot → Codex's cheap tier → its strong tier) is lost. The `server` skill keeps OnBud on the Mac and
sends only files, commands and logs to the server:

```
Mac: OnBud (plan · write code · approve · read results)
  │  your ssh (~/.ssh/config, ssh-agent, keys: read by ssh only)
  ▼
server: <dir>/.onbud/jobs/<id>.{sh,log,exit}  ·  STATUS.md  ·  tmux session / nohup / Slurm
  ▲
Mac terminal (Ghostty, iTerm, Terminal): fresh ssh://host/dir   or   ssh -t host 'cd dir && ttt' / a shell / tmux attach
```

- "gpu1에서 train.py 돌려줘" → the upload list (secrets such as `.env` and keys, `node_modules`, and files over
  50 MB left out) and the command; nothing runs until you say yes. Then the job starts in a tmux session (so you
  can attach and take over), with nohup, or with `sbatch`. The command passes the same security gate as a local one.
- "gpu1 진행 상황 알려줘" → the job's state and the log's last lines. "gpu1 fresh로 열어줘" / "ttt로" / "붙어줘" /
  "로그 따라가줘" → a terminal window on the server. `.onbud/STATUS.md` in the remote folder shows the job in the IDE's file tree.
- Hosts are the `Host` names in `~/.ssh/config`, or `~/OnBud/config/servers.json`
  (`{"servers": {"gpu1": {"host": "gpu1", "dir": "~/work/proj", "viewer": "fresh"}}}`; one entry there is the default).
  OnBud never opens key files or types passwords: `ssh` runs with `BatchMode=yes`, so connect once yourself
  (`ssh gpu1`) when a host needs a password or a new host key.
- CLI: `scripts/node-run.sh bin/afm-server.ts hosts | check | run | status | jobs | stop | pull | open`. Codex in
  OpenCode can read job state and logs with the `server_jobs` MCP tool (read-only).
- Fresh (GPL-3.0) and TTT (MIT) are optional third-party programs, installed separately under their own licenses.
  OnBud does not bundle or redistribute their source or binaries; it only starts them as external programs.

### GitHub Copilot (optional)

- **What is used:** only Copilot's *inline code completion*, through GitHub's official
  [`@github/copilot-language-server`](https://www.npmjs.com/package/@github/copilot-language-server) (MIT),
  installed into `~/OnBud/runtime/copilot-ls` when you ask. It is not bundled. OnBud does not use Copilot
  Chat, premium requests, the Copilot CLI or agents.
- **Plans:** completions are unlimited on Copilot Pro, Pro+ and Copilot Student (free for verified students
  through GitHub Education); Copilot Free has 2,000 completions a month. See
  [GitHub's plans](https://docs.github.com/en/copilot/concepts/billing/individual-plans).
- **Your account, your terms:** you sign in yourself on github.com (device code shown in Backend > GitHub
  Copilot). Use is under the [GitHub Terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
  and the [Copilot product terms](https://github.com/customer-terms) of
  your plan. OnBud never stores the token; the language server keeps it.
- **Editor-like use:** completion requests are at least 1.5 s apart and at most 120 an hour, so the
  controller behaves like one person typing in an editor.
- **What leaves the Mac:** the code being completed (the request's function and its context) goes to GitHub.
  The `code` skill is marked accordingly. Turn Copilot off in Backend > GitHub Copilot or with
  `ONBUD_COPILOT=off`; code then goes on-device first, then to Codex if allowed.

## How it works

```text
 ⌥ Space ─► OnBud.app ──127.0.0.1:11435──► controller (Node) ──127.0.0.1:11434──► apfel ─► Apple FoundationModels
                                              ├ security gate, secret redaction, folder guard
                                              ├ router: skill (rules, then the on-device model) · ask you · hand-off
                                              ├ 13 skills: files, code, git, writing, mac, web, server, …
                                              └ code: on-device plan ─► Copilot writes ─► checks ─► Codex cheap ─► Codex strong
```

- **Loopback only.** Every service binds to `127.0.0.1`; the controller needs a token kept in
  `~/OnBud/config` (mode 600).
- **Code checks, the model fills in.** Searching, counting, parsing and verifying are code; the model reads,
  summarizes and fills small schemas. Answers that cite files are checked against them.
- **You approve changes.** Commands, edits, web queries and jobs wait for an explicit yes; a security gate
  blocks destructive commands and secret leaks in the controller and in both OpenCode engines.

## Benchmarks

Code on a fresh held-out set (70 = HumanEval 40, LiveCodeBench v6 30), drawn and frozen before the code it
measures, run once per setup on the same day:

| | v0.1.0 | **v0.2.0** | Codex alone (Sol) | Codex alone (Terra) |
|---|---|---|---|---|
| Passed (70) | 58 | **66** | 67 | 65 |
| Codex calls | 45 | **41** | 70 | 70 |
| Codex cost (API-equivalent) | $0.19 | **$0.09** | $0.26 | $0.11 |
| Time | 29 min | 13 min | 10 min | 7 min |

Everyday file work stays on the Mac (framework eval 53/56 and skill eval 55/55, no Codex calls). For code, a
ladder: GitHub Copilot writes what it can (contest-style code only when a bundled difficulty classifier calls it
easy), Codex's cheap tier takes the rest, and its strong tier answers only when the cheap answer fails a check.
Against v0.1.0: 8 tasks more, half the cost, less than half the time. Against Codex alone: about the same
accuracy at a third of Sol's cost and 17% below Terra's, but slower (Copilot is paced like an editor). Every
setup: [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Documentation

| Document | What is in it |
|---|---|
| [docs/OVERVIEW.md](docs/OVERVIEW.md) | How OnBud works: launcher, controller, routing, skills, the code ladder, remote servers, limits |
| [apps/spotlight/README.md](apps/spotlight/README.md) | The launcher: panel, Backend and Routing (Strong / Cheap models), plugins, Skills window, widget, building the app and the DMG |
| [skills/README.md](skills/README.md) | Skill packs: the `skill.json` contract, evals, how to add a skill |
| [docs/skills-plan.md](docs/skills-plan.md) | Design notes and measurements behind the skills and the code ladder |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | Every benchmark setup and result, with the comparison to small open models |
| [tools/bench/BENCHMARK.md](tools/bench/BENCHMARK.md) | How to run the benchmarks yourself |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Building, testing, where things live, rollback |
| [docs/release-notes-0.2.3.md](docs/release-notes-0.2.3.md) | What changed in 0.2.3 · [0.2.2](docs/release-notes-0.2.2.md) · [0.2.1](docs/release-notes-0.2.1.md) · [0.2.0](docs/release-notes-0.2.0.md) (and how to upgrade from 0.1.0) · [0.1.0](docs/release-notes-0.1.0.md) |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Licenses of the projects, models and datasets OnBud uses or learned from |

## Apple Foundation Models, `fm` and licensing

> [!IMPORTANT]
> **Read Apple's terms before you build on Apple's models.**
> - OnBud reaches the on-device model through **apfel**, which uses Apple's public
>   [FoundationModels](https://developer.apple.com/documentation/foundationmodels) framework. Your use of
>   the model and of Apple Intelligence is governed by Apple's macOS license and Apple Intelligence terms,
>   not by OnBud's license.
> - OnBud does **not** use Apple's `fm` command-line tool (macOS 27). `fm` has its own terms: running it
>   means agreeing, among other things, not to *"programmatically access or use Apple models through Apple
>   software or services except as expressly permitted"*. Before you script `fm`, put `fm serve` behind
>   another program, or contribute such an integration here, read them yourself (`fm license --show`) and
>   the [macOS Software License Agreement](https://www.apple.com/legal/sla/).
> - OnBud does **not** use **Private Cloud Compute**. macOS allows PCC through `fm` only from the Terminal
>   app, and for third-party apps only with Apple's
>   [Private Cloud Compute entitlement](https://developer.apple.com/private-cloud-compute/). Please do not
>   send PRs that route around either restriction.

## Build from source

Needs the Command Line Tools (`xcode-select --install`); no Xcode.

```bash
git clone https://github.com/P-YI/OnBud.git ~/OnBud/adaptive-coding-agent
cd ~/OnBud/adaptive-coding-agent
scripts/setup.sh                       # apfel, Node.js, LaunchAgents (asks first)
npm test                               # controller tests
cd apps/spotlight && make install      # build the launcher into /Applications
make dmg                               # build/OnBud-<version>.dmg
```

More: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Uninstall

```bash
~/OnBud/adaptive-coding-agent/scripts/afm-launchagent.sh uninstall agent
~/OnBud/adaptive-coding-agent/scripts/afm-launchagent.sh uninstall apfel
brew uninstall --cask onbud          # or delete /Applications/OnBud.app
rm -rf ~/OnBud                       # controller copy, token, logs, history
```

## Contributing

**Contributions are welcome** — issues, ideas, docs, local skills, document readers, plugins, translations,
benchmarks. AI coding agents are welcome too (#agentswelcome); please review what they write before you
open a PR.

1. Open an issue for larger changes first.
2. Keep the defaults: loopback only, nothing installed without asking, changes behind approvals, on-device
   unless the user turns on a plugin.
3. Run `npm test` and, for the launcher, `cd apps/spotlight && make smoke`.
4. Respect the licenses of the projects OnBud builds on, and Apple's terms (see above).

## Acknowledgements

OnBud stands on [apfel](https://github.com/Arthur-Ficial/apfel), [OpenCode](https://opencode.ai),
[Ollaya](https://github.com/ollaya-dev/ollaya), [SearXNG](https://github.com/searxng/searxng),
GitHub's [Copilot language server](https://www.npmjs.com/package/@github/copilot-language-server),
[Homebrew](https://brew.sh) and [Node.js](https://nodejs.org) — please star and support them. Ideas came
from [fm-guide](https://github.com/llostinthesauce/fm-guide), [fm-proxy](https://github.com/gregbarbosa/fm-proxy),
[LocalCode](https://github.com/localcodeai/localcode), [OpenClaw](https://github.com/openclaw/openclaw),
[me-box](https://github.com/coallaoh/me-box) and [Laya](https://github.com/mizorewww/laya-mlx). Licenses and
what was adopted: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE) © 2026 Yein Park. Third-party projects keep their own licenses and are not bundled.
OnBud is an independent project, not affiliated with, endorsed or sponsored by Apple Inc. Apple, Apple
Intelligence, macOS and Spotlight are trademarks of Apple Inc., registered in the U.S. and other countries.
