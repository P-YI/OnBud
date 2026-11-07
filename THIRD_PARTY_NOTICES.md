# Third-party software and references

OnBud is licensed under the MIT License (see `LICENSE`). That license covers OnBud's own code only.
Everything below keeps its own license.

## What the OnBud app ships

- The launcher app (`apps/spotlight`), the controller (`bin/`, `services/`, `policies/`, `scripts/`,
  `opencode/`) and the helpers `tools/pdftext` and `tools/translate` are OnBud's own code. The app
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
| GitHub Copilot language server (`@github/copilot-language-server`) | Copilot tier: inline code completion with the user's own Copilot plan | MIT (the package); the Copilot service is under GitHub's terms and the user's plan | https://www.npmjs.com/package/@github/copilot-language-server |
| Ollaya | Router model plugin: serves the router model | Apache-2.0 | https://github.com/ollaya-dev/ollaya |
| Decima (`decima:agent`) | default router model | Apache-2.0 model; part of its training data is CC BY-NC, so check before any commercial use | https://ollaya.dev/library/decima |
| SearXNG | Web search plugin (optional local search engine) | AGPL-3.0 | https://github.com/searxng/searxng |
| MacTeX / TeX Live | LaTeX plugin | several free licenses (TeX Live) | https://www.tug.org/mactex/ |
| ripgrep, tmux | faster code search; background sessions (optional) | MIT/Unlicense; ISC | https://github.com/BurntSushi/ripgrep · https://github.com/tmux/tmux |
| GitHub CLI (`gh`) | read-only GitHub status (optional) | MIT | https://cli.github.com |
| Fresh (`fresh-editor`) | Remote server plugin: shows a server folder as a terminal IDE (`fresh ssh://host/dir`); started as a separate program, not linked or bundled | GPL-3.0 | https://github.com/sinelaw/fresh · `brew install fresh-editor` |
| TTT | Remote server plugin (optional): a terminal IDE the user installs on the server; started over `ssh -t` | MIT | https://github.com/eugenioenko/ttt |

Apple Intelligence, the Foundation Models framework and Apple's translation models are part of macOS and
are used under Apple's terms. OnBud uses them on-device through apfel and the public frameworks; it does
not use Apple's `fm` command-line tool or Private Cloud Compute. Anyone extending OnBud in that direction
must read Apple's terms first (see the README).

## Design references

OnBud took ideas from these projects and reimplemented them; no code was copied from them. What was
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
HumanEval (MIT, https://github.com/openai/human-eval), BigCodeBench (Apache-2.0) and LiveCodeBench
(https://livecodebench.github.io). The v0.1.0 release also used BFCL and a Terminal-Bench-style suite. The `ml-impl` tasks in `tools/bench`
were written for OnBud.

## Training data (weights shipped)

`skills/code/difficulty.json` (the code skill's difficulty classifier) holds logistic-regression weights over
hashed word features, trained by `tools/code-difficulty/train.py` on the problem descriptions and ratings of
DeepMind CodeContests (https://huggingface.co/datasets/deepmind/code_contests), licensed CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/). No text from the dataset is stored in the repository; the
training script reads the dataset at run time.
