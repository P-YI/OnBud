# How OpenAFM works (v0.1)

OpenAFM puts Apple's on-device Foundation Model to work on your own files, with code doing everything the
small model is bad at: finding files, reading documents, running and checking things, and asking you before
anything changes. Larger tasks can be handed to Codex through OpenCode, if you turn that on.

```text
 ⌥ Space ─► OpenAFM.app (SwiftUI launcher, widget, menu bar)
                │  http://127.0.0.1:11435  (bearer token, loopback only)
                ▼
          OpenAFM controller (Node, bin/afm-agent-server.ts)
          ├─ security gate · secret redaction · project-folder guard
          ├─ router (rules, optional local router model) ─► local skill / AFM / Codex hand-off
          ├─ context builder: Spotlight + ripgrep search, PDF/Office/iWork/HWPX/image reading (OCR), sheets
          ├─ tools: commands (approval), edits (sandbox trial + tests, then approval), LaTeX, web (approval)
          └─ memory, telemetry, local jobs in git worktrees
                │  http://127.0.0.1:11434
                ▼
          apfel ─► Apple FoundationModels (on-device)        optional: Ollaya + Decima (11436),
                                                             SearXNG (8888), OpenCode + Codex
```

## What is implemented

**Launcher app** (`apps/spotlight`, Swift, built with the Command Line Tools only)
- Floating panel on a global hotkey (⌥ Space; ⌃ Space or ⌘ Space in Settings), project-folder and model
  menus, quick actions that fit the folder (papers, documents, git changes, commit messages).
- Answers rendered from Markdown (headings, tables, lists, code) and written out progressively, with live
  progress steps from the controller; clickable links (web pages, files in your home folder).
- Approve / deny buttons for every command, edit, web search and local job; fold the answers or start a
  new chat; history, attachments (drop files, clipboard, Services menu "Ask OpenAFM"), `openafm://` URLs.
- Chat widget (WidgetKit), menu-bar logo that lights up while the model works, notifications.
- Guided setup and plugins: each extra is installed from its own project, in Terminal, after asking.

**Controller** (`bin/`, `services/`, `policies/`, Node 22.6+, no npm dependencies)
- **Routing:** deterministic rules decide between a local skill, the on-device model, asking you, or a
  Codex hand-off; an optional router model (Decima on Ollaya) can advise on generic requests.
- **Local skills** (code gathers and checks, the model fills small schemas): commit messages, change
  summaries, release notes, error-log triage, translation, docstrings, privacy scan, CSV ↔ JSON,
  spreadsheet lookup, slide outlines, git and GitHub (read-only) status, Mac health check.
- **Documents:** PDF text and Vision OCR (`tools/pdftext`), Word, slides, spreadsheets, iWork, HWPX and
  images; questions are framed, the whole document is searched, and answers are checked against the lines
  they cite.
- **Commands and edits:** read-only commands run directly; anything else waits for approval. Edits are
  tried in a sandbox copy with the project's tests before a separate "apply?" question. Long runs go to
  background sessions (tmux).
- **Local jobs:** offline multi-step code or LaTeX work in a git worktree, with a journal, then
  Continue / Apply / Review / Discard.
- **LaTeX:** compile with latexmk, summarize the log, fix errors, check citations and references.
- **Web search** (off unless enabled): every query needs your approval; local SearXNG if installed.
- **Safety:** a security gate shared by the controller and both OpenCode engines (destructive commands,
  secrets, paths outside the project), secret redaction before any model call, loopback-only services.
- **OpenCode integration:** the controller doubles as the `afm` agent and an MCP server
  (`bin/afm-mcp-server.ts`) that gives frontier agents local document, search and LaTeX tools.

## Design references

OpenAFM reimplemented ideas from these projects (no code was copied); see `THIRD_PARTY_NOTICES.md`.
- **apfel:** the on-device model behind an OpenAI-compatible API.
- **fm-guide:** document chunks of about 1.5k tokens; "structure, never truth", hence the check that cited
  paths exist; temperature 0.
- **fm-proxy:** one-schema tool dispatch (forced calls as one object with a property per tool); guardrail
  refusals as their own failure class; retries only for transient errors; output caps.
- **LocalCode:** the model proposes shell commands, the user approves them.
- **OpenClaw (`apple-fm`):** the on-device model is a utility model; the host owns tool execution and approvals.
- **me-box:** one git worktree per concurrent task, durable sessions, a running record of the build state.
- **Laya / Ollaya / Decima:** typed routing decisions (route, secret, destructive) from a small local model.

## Limits

- The on-device model has an 8,192-token window (4,096 on older Macs and macOS 26); long documents are
  searched and excerpted, never read whole.
- On its own it solves few coding benchmark problems (see `BENCHMARKS.md`); multi-file changes, new
  features and hard debugging are what the Codex hand-off is for.
- OpenAFM does not use Apple's `fm` command-line tool or Private Cloud Compute (see the README).
