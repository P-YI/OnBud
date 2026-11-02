<p align="center">
  <img src="docs/assets/OpenAFM_banner.png" alt="OpenAFM — Spotlight-style open-source framework for Apple Foundation Models" width="100%">
</p>

<h3 align="center">Apple's on-device model, put to work on your own files.</h3>

<p align="center">
  <a href="https://github.com/P-YI/OpenAFM/releases"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version 0.1.0"></a>
  <a href="https://developer.apple.com/macos/"><img src="https://img.shields.io/badge/macOS-26%20Tahoe%2B-000000?logo=apple&logoColor=white" alt="macOS 26 Tahoe+"></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/Apple%20silicon-M1%2B-555555?logo=apple&logoColor=white" alt="Apple silicon"></a>
  <a href="https://swift.org"><img src="https://img.shields.io/badge/Swift-6-F05138?logo=swift&logoColor=white" alt="Swift"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-22.6%2B-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 22.6+"></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/Xcode-not%20required%20(Command%20Line%20Tools)-orange" alt="Xcode not required: the Command Line Tools come with Homebrew"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://developer.apple.com/documentation/foundationmodels"><img src="https://img.shields.io/badge/inference-on--device%20by%20default-green" alt="On-device by default"></a>
  <a href="#install"><img src="https://img.shields.io/badge/Homebrew-tap-FBB040?logo=homebrew&logoColor=white" alt="Homebrew tap"></a>
  <a href="https://github.com/Arthur-Ficial/apfel"><img src="https://img.shields.io/badge/powered%20by-apfel-16A34A" alt="Powered by apfel"></a>
</p>

<p align="center">
  <a href="#contributing"><img src="https://img.shields.io/badge/%23agentswelcome-PRs%20welcome-0066cc?style=for-the-badge&labelColor=0d1117&logo=probot&logoColor=white" alt="PRs welcome"></a>
</p>

Every Apple silicon Mac with Apple Intelligence has a ~3B language model built in. On its own it is a good
reader and a weak programmer. **OpenAFM** wraps it in code that does the searching, reading, running and
checking, and asks you before anything changes. Press **⌥ Space**, ask about a folder, a paper, a
spreadsheet or your git changes, and approve or deny each command and edit. Answers are computed on your Mac;
nothing leaves it unless you turn on a plugin that says so.

| | What you get |
|---|---|
| **Launcher** | A Spotlight-style panel (⌥ Space), chat widget, menu-bar activity light, Services menu "Ask OpenAFM" |
| **Local agent** | Routing, local skills, document reading with OCR, commands and edits behind approvals, LaTeX, local jobs |
| **Plugins** | Router model (Ollaya + Decima), Codex via OpenCode, web search (SearXNG), LaTeX (MacTeX), translation languages — each installed from its own project when you need it |
| **OpenCode** | The same controller as an OpenCode agent (`afm`) and an MCP server for frontier agents |

## Requirements

- Apple silicon Mac (M1 or later), **macOS 26 Tahoe or later**
- **Apple Intelligence** turned on (System Settings > Apple Intelligence & Siri)
- [apfel](https://github.com/Arthur-Ficial/apfel) and Node.js 22.6+ — setup installs them with Homebrew if they are missing
- **No Xcode.** Apple's Command Line Tools (git, python3, swiftc) are enough; Homebrew installs them with
  itself. OpenAFM uses `swiftc` only to build its small helpers on first use if they are missing.

Optional, for single features (install them when you want the feature):

| Feature | Needs |
|---|---|
| GitHub status (read-only: PRs, issues, CI) | [`gh`](https://cli.github.com) and `gh auth login` |
| Long-running commands in background sessions | [`tmux`](https://github.com/tmux/tmux) (`brew install tmux`) |
| Faster code search | [`ripgrep`](https://github.com/BurntSushi/ripgrep) (`brew install ripgrep`; else `git grep`) |
| Router model, Codex, web search, LaTeX, translation | the matching plugin in Settings > Plugins (see [Plugins](#plugins)) |

## Install

**Homebrew** (also installs apfel and Node.js):

```bash
brew tap p-yi/openafm https://github.com/P-YI/OpenAFM
brew trust --cask p-yi/openafm/openafm      # Homebrew 7+: allow this one third-party cask
brew install --cask p-yi/openafm/openafm
```

**DMG:** download `OpenAFM-0.1.0.dmg` from [Releases](https://github.com/P-YI/OpenAFM/releases) and drag
OpenAFM to Applications.

> [!NOTE]
> OpenAFM is not signed with a Developer ID or notarized. The first launch is blocked with "Apple could not
> verify…". Open **System Settings > Privacy & Security** and click **Open Anyway**, or run
> `xattr -dr com.apple.quarantine /Applications/OpenAFM.app`.

Then open OpenAFM and click **Set up OpenAFM…**. Terminal opens and, asking before each step:

1. checks the Mac (Apple silicon, macOS 26+);
2. installs what is missing from each project's own source: Homebrew, `brew install apfel`, `brew install node`;
3. copies the controller to `~/OpenAFM/adaptive-coding-agent`;
4. starts apfel (`127.0.0.1:11434`) and the controller (`127.0.0.1:11435`) at login.

Update: `brew upgrade --cask openafm` (or a newer DMG), then Settings > Backend > **Update…**.

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

Drop files on the panel, paste from the clipboard, or select text in any app > Services > **Ask OpenAFM**.
`openafm://ask?q=…&folder=…` opens the panel from Shortcuts, Raycast or scripts.

## What it can do

| Area | How |
|---|---|
| Find and read | Spotlight + ripgrep search; PDF text and Vision OCR, Word, slides, spreadsheets, iWork, HWPX, images |
| Answer about documents | frame the question, search the whole document, check the answer against the lines it cites |
| Developer help | commit messages, change summaries, release notes, error-log triage, docstrings, git/GitHub status (read-only) |
| Run and change | read-only commands run directly; other commands, edits (tested in a sandbox first) and web searches wait for approval |
| Longer work | local jobs in a git worktree with a journal; Continue / Apply / Review / Discard |
| Papers | LaTeX compile, error fixes, citation and reference checks, CSV → booktabs tables |
| Hand-off | tasks too big for the small model go to Codex in OpenCode (plugin), with the request and context |

Details: [docs/OVERVIEW.md](docs/OVERVIEW.md) · launcher: [apps/spotlight/README.md](apps/spotlight/README.md).

## Plugins

Settings > Plugins. Each one says what it downloads and opens Terminal with the exact commands; nothing
installs in the background.

| Plugin | Adds | From |
|---|---|---|
| Router model | "AFM + Decima": a 321M local model advises the router | [Ollaya](https://github.com/ollaya-dev/ollaya) + [Decima](https://ollaya.dev/library/decima) |
| Codex via OpenCode | hand big tasks to Codex; "Review with Codex" for local jobs | [OpenCode](https://opencode.ai) |
| Web search | approval-gated web search; a private local search engine if installed | [SearXNG](https://github.com/searxng/searxng) (else DuckDuckGo Lite, arXiv, Wikipedia) |
| LaTeX | compile papers and fix errors | [MacTeX](https://www.tug.org/mactex/) |
| Translation languages | offline translation packs for the translator | Apple's Translation framework |

## How it works

```text
 ⌥ Space ─► OpenAFM.app ──127.0.0.1:11435──► controller (Node) ──127.0.0.1:11434──► apfel ─► Apple FoundationModels
                                              ├ security gate, secret redaction, folder guard
                                              ├ router: local skill · on-device model · ask you · Codex hand-off
                                              └ tools: search, documents, commands, edits, LaTeX, web, jobs
```

- **Loopback only.** Every service binds to `127.0.0.1`; the controller needs a token kept in
  `~/OpenAFM/config` (mode 600).
- **Code checks, the model fills in.** Searching, counting, parsing and verifying are code; the model reads,
  summarizes and fills small schemas. Answers that cite files are checked against them.
- **You approve changes.** Commands, edits, web queries and jobs wait for an explicit yes; a security gate
  blocks destructive commands and secret leaks in the controller and in both OpenCode engines.

## Benchmarks

| | AFM alone | OpenAFM (on-device) | OpenAFM + Codex | Codex alone |
|---|---|---|---|---|
| Own task suite | 2/15 | **62/66 (94%)**, 1.9 s median | 26/27 | 25/27 |
| HumanEval (40) | 33% | 35% | **100%** | 100% |
| LiveCodeBench v6 (30) | 7% | 10% | **97%** | 97% |
| Codex cost (API-equivalent) | $0 | $0 | $0.34 | $0.90 |

The on-device model handles everyday file work almost entirely locally; with the Codex plugin, coding
benchmarks reach Codex's level at about 38% of its cost. Methods, BFCL tool-calling and small open models:
[docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Apple Foundation Models, `fm` and licensing

> [!IMPORTANT]
> **Read Apple's terms before you build on Apple's models.**
> - OpenAFM reaches the on-device model through **apfel**, which uses Apple's public
>   [FoundationModels](https://developer.apple.com/documentation/foundationmodels) framework. Your use of
>   the model and of Apple Intelligence is governed by Apple's macOS license and Apple Intelligence terms,
>   not by OpenAFM's license.
> - OpenAFM does **not** use Apple's `fm` command-line tool (macOS 27). `fm` has its own terms: running it
>   means agreeing, among other things, not to *"programmatically access or use Apple models through Apple
>   software or services except as expressly permitted"*. Before you script `fm`, put `fm serve` behind
>   another program, or contribute such an integration here, read them yourself (`fm license --show`) and
>   the [macOS Software License Agreement](https://www.apple.com/legal/sla/).
> - OpenAFM does **not** use **Private Cloud Compute**. macOS allows PCC through `fm` only from the Terminal
>   app, and for third-party apps only with Apple's
>   [Private Cloud Compute entitlement](https://developer.apple.com/private-cloud-compute/). Please do not
>   send PRs that route around either restriction.

## Build from source

Needs the Command Line Tools (`xcode-select --install`); no Xcode.

```bash
git clone https://github.com/P-YI/OpenAFM.git ~/OpenAFM/adaptive-coding-agent
cd ~/OpenAFM/adaptive-coding-agent
scripts/setup.sh                       # apfel, Node.js, LaunchAgents (asks first)
npm test                               # controller tests
cd apps/spotlight && make install      # build the launcher into /Applications
make dmg                               # build/OpenAFM-<version>.dmg
```

More: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Uninstall

```bash
~/OpenAFM/adaptive-coding-agent/scripts/afm-launchagent.sh uninstall agent
~/OpenAFM/adaptive-coding-agent/scripts/afm-launchagent.sh uninstall apfel
brew uninstall --cask openafm          # or delete /Applications/OpenAFM.app
rm -rf ~/OpenAFM                       # controller copy, token, logs, history
```

## Contributing

**Contributions are welcome** — issues, ideas, docs, local skills, document readers, plugins, translations,
benchmarks. AI coding agents are welcome too (#agentswelcome); please review what they write before you
open a PR.

1. Open an issue for larger changes first.
2. Keep the defaults: loopback only, nothing installed without asking, changes behind approvals, on-device
   unless the user turns on a plugin.
3. Run `npm test` and, for the launcher, `cd apps/spotlight && make smoke`.
4. Respect the licenses of the projects OpenAFM builds on, and Apple's terms (see above).

## Acknowledgements

OpenAFM stands on [apfel](https://github.com/Arthur-Ficial/apfel), [OpenCode](https://opencode.ai),
[Ollaya](https://github.com/ollaya-dev/ollaya), [SearXNG](https://github.com/searxng/searxng),
[Homebrew](https://brew.sh) and [Node.js](https://nodejs.org) — please star and support them. Ideas came
from [fm-guide](https://github.com/llostinthesauce/fm-guide), [fm-proxy](https://github.com/gregbarbosa/fm-proxy),
[LocalCode](https://github.com/localcodeai/localcode), [OpenClaw](https://github.com/openclaw/openclaw),
[me-box](https://github.com/coallaoh/me-box) and [Laya](https://github.com/mizorewww/laya-mlx). Licenses and
what was adopted: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE) © 2026 Yein Park. Third-party projects keep their own licenses and are not bundled.
OpenAFM is not affiliated with or endorsed by Apple. Apple, Apple Intelligence and macOS are trademarks of
Apple Inc.
