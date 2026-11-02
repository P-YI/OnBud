# Development

Work from a checkout in `~/OpenAFM/adaptive-coding-agent` (the controller, scripts and app assume that
path; set `OPENAFM_HOME`/`OPENAFM_REPO` to use another). Runtime data lives outside the repository in
`~/OpenAFM/runtime`, the controller token in `~/OpenAFM/config`.

```bash
git clone https://github.com/P-YI/OpenAFM.git ~/OpenAFM/adaptive-coding-agent
cd ~/OpenAFM/adaptive-coding-agent
scripts/setup.sh                 # apfel, Node.js 22.6+, LaunchAgents (asks before each step)
npm test                         # controller unit tests (node:test, no npm dependencies)
cd apps/spotlight && make install   # the launcher (Command Line Tools only, no Xcode)
make smoke                       # launcher checks + live requests through the running controller
```

## Using the controller from OpenCode (optional)

`opencode/opencode.global.jsonc` defines the `afm` provider and agents, the `codex` agent and the `openafm`
MCP server; paths use `{env:HOME}`. Merge it into your global OpenCode config with the launcher (Settings >
OpenCode config: shows a diff, backs up first) or symlink it as `~/.config/opencode/opencode.jsonc`. Copy
`opencode/global-plugin-loader.ts` to `~/.config/opencode/plugins/openafm-security-gate.ts` to load the
security gate in both OpenCode engines.

## Where things live

- **OpenCode config is global**: `opencode/opencode.global.jsonc` (symlinked from `~/.config/opencode/opencode.jsonc`), so AFM is available in every folder. Default agent: `afm`.
- Frontier model / reasoning effort: `opencode/opencode.global.jsonc` → `agent.codex.model`, `agent.codex.variant`
- Security gate plugin: sources `opencode/plugin/security-gate.ts` (1.x) and `security-gate-v2.ts` (2.x desktop), one global loader `~/.config/opencode/plugins/openafm-security-gate.ts` (copy: `opencode/global-plugin-loader.ts`) for both engines.
- AFM system prompt: `policies/AFM.md` (OpenCode `agent.afm-local.prompt`, controller, `apfel --system-file`)
- Routing thresholds, skill map: `policies/routing.yaml`; skills: `policies/skills/`
- OpenCode agents: `codex` (GPT-6.1 Sol), `afm` (controller via `bin/afm-agent-server.ts`, port 11435), `afm-local` (raw AFM, no tools)
- Security gate logic: `services/security/`
- Controller CLI: `node --experimental-strip-types bin/afm-task.ts [--allow-frontier] "request"`
- apfel service: `scripts/afm-launchagent.sh install|uninstall|status|restart`; token `~/OpenAFM/config/apfel.token`
- Telemetry/memory DB: `~/OpenAFM/runtime/db/openafm.sqlite`; report: `node --experimental-strip-types --experimental-sqlite bin/report.ts --days 7`
- Native helpers (PDF text + OCR): `scripts/build-tools.sh` → `~/OpenAFM/runtime/bin/pdftext`
- Quick benchmarks: `tools/bench/fetch-bfcl.sh` then `node --experimental-strip-types tools/bench/bfcl-eval.ts --n 20`; `node --experimental-strip-types --experimental-sqlite tools/bench/terminal-mini.ts`
- Unit tests: `npm test`

## Quick checks

```bash
scripts/doctor.sh                      # read-only environment report
scripts/apfel-smoke.sh                 # CLI smoke tests (local model only, no network)
scripts/afm-launchagent.sh status [apfel|agent]   # login services (loopback + token)
scripts/start-afm.sh / stop-afm.sh     # manual apfel server when the LaunchAgent is not installed
```

## Rollback

Restore `~/OpenAFM/runtime/reports/opencode.jsonc.global-backup-*` over the `~/.config/opencode/opencode.jsonc` symlink and delete `~/.config/opencode/plugins/openafm-security-gate.ts` to detach OpenCode. `scripts/afm-launchagent.sh uninstall` removes the only persistent component (a per-user LaunchAgent). `opencode auth logout` removes the ChatGPT login. No system-wide config or shell init is modified.
