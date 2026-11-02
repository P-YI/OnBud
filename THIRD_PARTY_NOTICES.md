# Third-party software and references

OpenAFM is licensed under the MIT License (see `LICENSE`). That license covers OpenAFM's own code only.
Everything below keeps its own license.

## What the OpenAFM app ships

- The launcher app (`apps/spotlight`), the controller (`bin/`, `services/`, `policies/`, `scripts/`,
  `opencode/`) and the helpers `tools/pdftext` and `tools/translate` are OpenAFM's own code. The app
  bundles a copy of the controller so that setup does not need a git checkout.
- No third-party code or model weights are bundled. The helpers link only Apple system frameworks
  (FoundationModels, Translation, Vision, PDFKit, AppKit, SwiftUI, WidgetKit), which stay under Apple's
  macOS license.

## Installed by the user, on demand

Setup and the plugins only run the official installers of these projects, in Terminal, after asking.
They come from their own projects, under their own licenses. Please support and contribute to them.

| Project | Used for | License | Where |
|---|---|---|---|
| apfel (Arthur Ficial, Franz Enzenhofer) | the on-device Apple model as an OpenAI-compatible server (core) | MIT | https://github.com/Arthur-Ficial/apfel · `brew install apfel` |
| Node.js | runs the controller (core) | MIT | https://nodejs.org · `brew install node` |
| Homebrew | installs apfel and Node | BSD-2-Clause | https://brew.sh |
| OpenCode | Codex plugin: hands big tasks to Codex | MIT | https://opencode.ai |
| Ollaya | Router model plugin: serves the router model | Apache-2.0 | https://github.com/ollaya-dev/ollaya |
| Decima (`decima:agent`) | default router model | Apache-2.0 model; part of its training data is CC BY-NC, so check before any commercial use | https://ollaya.dev/library/decima |
| SearXNG | Web search plugin (optional local search engine) | AGPL-3.0 | https://github.com/searxng/searxng |
| MacTeX / TeX Live | LaTeX plugin | several free licenses (TeX Live) | https://www.tug.org/mactex/ |
| ripgrep, tmux | faster code search; background sessions (optional) | MIT/Unlicense; ISC | https://github.com/BurntSushi/ripgrep · https://github.com/tmux/tmux |

Apple Intelligence, the Foundation Models framework and Apple's translation models are part of macOS and
are used under Apple's terms. OpenAFM uses them on-device through apfel and the public frameworks; it does
not use Apple's `fm` command-line tool or Private Cloud Compute. Anyone extending OpenAFM in that direction
must read Apple's terms first (see the README).

## Design references

OpenAFM took ideas from these projects and reimplemented them; no code was copied from them. What was
adopted is summarized in `docs/OVERVIEW.md` (Design references).

| Project | Idea taken |
|---|---|
| apfel — https://github.com/Arthur-Ficial/apfel | serving the on-device model over an OpenAI-compatible API |
| fm-guide — https://github.com/llostinthesauce/fm-guide | document chunk sizes, context limits, "structure, never truth" answer checks |
| fm-proxy — https://github.com/gregbarbosa/fm-proxy | one-schema tool dispatch, guardrail failure class, retry rules, output caps |
| LocalCode — https://github.com/localcodeai/localcode | AFM proposes shell commands, the user approves them in OpenCode |
| OpenClaw `apple-fm` plugin — https://github.com/openclaw/openclaw | AFM as a utility model; the host owns tool execution and approvals |
| me-box — https://github.com/coallaoh/me-box | one git worktree per concurrent task, durable sessions, a running build-state record |
| Laya (laya-mlx) — https://github.com/mizorewww/laya-mlx | the routing-decision design behind `services/laya-router` |
| open-apple-models — https://github.com/SpaceCorps/open-apple-models | notes on Apple's on-device models |
| Ollaya / Decima — https://github.com/ollaya-dev/ollaya | the typed decision model (route, secret, destructive) used as a router |

## Benchmarks (evaluation only)

`tools/bench` fetches these datasets at run time. The repository stores only task IDs and its own results:
HumanEval (MIT, https://github.com/openai/human-eval), BigCodeBench (Apache-2.0), LiveCodeBench,
the Berkeley Function-Calling Leaderboard (BFCL) and Terminal-Bench. The `ml-impl` tasks in `tools/bench`
were written for OpenAFM.
