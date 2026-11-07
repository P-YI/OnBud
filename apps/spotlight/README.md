# OnBud launcher (`apps/spotlight`)

A small, open-source, Spotlight/Raycast-style launcher for local AFM work. Press **⌥ Space**, ask about the
project, approve or deny commands and edits from the panel. It runs without OpenCode, and its setup
installs only what is missing (apfel, Node.js), from their own projects, after asking. Extras come as **plugins**: a router model (Decima by
default), Codex through OpenCode, web search, LaTeX and translation languages. A **chat widget** shows the
last question and answer on the desktop.

| | |
|---|---|
| UI | SwiftUI + AppKit; floating, non-activating panel; menu-bar item (`LSUIElement`, no Dock icon) |
| Hotkey | Carbon `RegisterEventHotKey`, so no Accessibility permission. ⌥ Space by default; ⌃ Space or ⌘ Space in Settings |
| Backend | the OnBud controller on `127.0.0.1:11435` (`bin/afm-agent-server.ts`), which uses apfel/AFM on 11434 and, for S3, a router model on Ollaya (11436) |
| Build | SwiftPM with the Command Line Tools only (no Xcode project) |

## Build and run

```sh
cd apps/spotlight
make app      # build/Products.noindex/OnBud.app: release build, icon, chat widget, bundled controller, ad-hoc signature
make install  # make app, then copy to /Applications and register only that copy
make run      # build and open with the panel shown
make dmg      # build/OnBud-<version>.dmg; make release also writes version and sha256 into Casks/onbud.rb
make smoke    # core checks + live requests through the running controller (make smoke SMOKE_ARGS=--offline to skip them)
```

`make app` runs `scripts/make-icons.swift` (Core Image):
- **App icon:** `Resources/Artwork/AppLogo.png`, with stray specks removed (alpha threshold plus a
  3 px morphological opening), in its own colors, cropped to its content and filling ~84% of a light-blue
  rounded square (gradient #EAF4FD → #D4E8F8; `ICON_BG` overrides it). `iconutil` turns it into
  `AppIcon.icns`, and the panel shows the same logo.
- **Menu-bar icon:** a black silhouette of `Resources/Artwork/MenuBarLogo.png`, cropped to its content. It
  is a template image, so macOS shows it white on a dark menu bar. **While AFM works** (a panel request,
  or the controller's `/health` reporting `busy` for any client, checked every 2 s) the logo's own colors
  rise through it from the bottom up, hold for a moment and leave through the top, until the work is done.

Override the sources with `make app ICON_SRC=… MENUBAR_SRC=…`.

To keep the app, run `make install` (or drag the app from the DMG to `/Applications`). Development builds
live in a `.noindex` folder, so Spotlight and Launchpad show only the installed copy. **Launch at login** in
Settings registers the running copy through `SMAppService`; after moving the app, turn it off and on again.
macOS may ask you to approve it under General > Login Items.

## Panel

- **Top row:** the OnBud logo and the "Ask OnBud" field. While a request runs, the reply area shows
  the controller's live steps ("Searching the folder…", "Writing a commit message…", …). The controller
  produces each answer in one structured generation and sends it in one piece, so the panel writes it
  out word by word (at most ~0.8 s) instead of dropping it in at once.
- **Attachments** (they appear as chips under the field):
  - drop files onto the panel;
  - paperclip menu > *Paste from clipboard* (copied text, or files copied in Finder) or *Choose files…*;
  - select text or files in any app > Services > **Ask OnBud**.

  Files are named in the request relative to the project folder. Files outside it switch a new chat to
  their folder (the same folder rules apply). Text is quoted, up to 4,000 characters.
- **Bottom row:**
  - **Folder:** the project folder (default `~/Desktop`), with the last six folders and *Choose folder…*.
  - **Model:** **AFM Agent** (on-device AFM with local tools) or **AFM + <router>** (needs the Router
    model plugin; "AFM + Decima" with decima:agent). With several router models installed, this menu
    also picks one. It also has the web-search switch.
  - **Chevron (⌘L):** folds the answers into one line ("“…” · N answers folded") and back. The chat
    goes on: follow-ups still see the earlier turns and pending approvals stay. **New chat** (⌘N) is
    different: it ends the chat, so the controller forgets the history and pending approvals, and the
    panel is empty again (nothing left to fold).
  - **Earlier answers fold by themselves:** only the latest answer is open; a "▸ N earlier answers folded"
    line unfolds the others. The panel keeps at most five earlier answers; older ones stay in the saved chat
    (clock menu), and the controller still sees the whole chat.
  - **Paperclip:** attachments, as above.
  - **Clock:** the last chats (re-open one and continue it), *Activity…* and *Clear history*.
- **Quick actions** (shown while the panel is empty) fit the folder:
  - *Compile the paper* (needs the LaTeX plugin) and *Check citations*, when there is a `.tex` file;
  - *Describe the documents*, for PDF, Word, slides or images;
  - *Summarize changes*, *Commit message*, *Recent commits* and *Local jobs*, in git repositories
    (the first two run the controller's local `change_summary` / `commit_message` skills);
  - *Terminal here* (the controller's `open_app` skill, in your terminal app) and *Commands*, always.
- **Opening apps:** "open a terminal here", "open it in my editor" and "<app> 열어줘 / open <app>" run the
  controller's `open_app` / `launch_app` skills. Settings > **Apps OnBud opens** picks the terminal,
  editor and browser (`~/OnBud/config/apps.json`, shared with the controller); OnBud's own Terminal
  windows (setup, plugin installs, sign-ins) use the same terminal.
- **Each answer** is rendered from Markdown: headings, tables as grids, lists, quotes and code blocks. It
  has Copy and Save-as-Markdown buttons.
- **Links in answers are clickable** (see How it works for what opens).
- **Notifications:** if the panel is closed when an answer arrives, a notification is shown (Settings).
- **History** is kept in `~/Library/Application Support/OnBud/history.json` (mode 600, last 50 chats).
  Turning it off in Settings deletes it.
- **Activity window** (menu bar or clock menu) lists:
  - the controller's local jobs (`~/OnBud/runtime/jobs`), with *Continue / Apply / Review with Codex /
    Discard* buttons that send the matching chat command, so the usual yes/no approval follows;
  - its background sessions (`tmux -L onbud`).
- **`onbud://ask?q=<text>&folder=<path>`** opens the panel with the question typed in, for Shortcuts,
  Raycast or scripts. It never sends by itself.
- The panel has a fixed width and grows downwards. It closes on Esc or when it loses focus.

## How it works

- **At launch and each time the panel opens**, it probes 127.0.0.1:11434 (apfel `/health`), 11435
  (controller `/health`) and 11436 (Ollaya `/api/tags`). It also looks for `~/OnBud`, the token
  `~/OnBud/config/apfel.token` and the `dev.onbud.agent` / `dev.onbud.apfel` LaunchAgents.
  - If nothing is installed, the panel shows a setup screen with *Set up OnBud…* (see Distribution).
  - If the controller is down, the panel shows the `launchctl kickstart` line instead.
- **Requests** go to `POST /v1/chat/completions` with the bearer token, `stream: true`, and the panel's project
  folder sent as an OpenCode-style `Working directory:` line. The controller only reads folders inside
  `$HOME`, and never `$HOME` itself. Replies stream into the panel.
- **Settings.** The launcher sends `x-onbud-setting: s2|s3`. With that header, the server runs the request
  like the evaluation settings: S2 = rules only, S3 = + router advise, and both with web search and Codex
  off. Without the header the server behaves as before, so OpenCode is unaffected. S3 is used only if
  the router plugin is on and Ollaya is reachable. With S3 the launcher also sends
  `x-onbud-router-model: <name>` for the router model picked in Settings. The thresholds' digest pin
  still applies, so a model other than the calibrated decima:agent is only logged in shadow. As in the
  evaluation, the router advises only on generic routes; skill routes (documents, edits, commands) stay
  with the rules.
- **Approvals.** The controller keeps its own approve/deny flow. In launcher requests, its final stream
  chunk carries `onbud.awaiting`: `command`, `edit`, `apply`, `web`, `job`, `handoff` or `reveal`. The
  panel turns this into buttons:
  - **Yes / No** (⌘↩ / ⌘⌫) send `yes` / `no` as the next turn, which is exactly what you would type in
    OpenCode.
  - The security gate still applies on the server, and edits go sandbox trial → tests → a separate
    "apply?".
- **Escalations** (too big for AFM) offer three choices:
  - **Send to Codex (OpenCode)**: needs the Codex plugin. See Plugins below.
  - **Try locally on a branch**: the controller's local job engine.
  - **No**.

  The launcher's models never call Codex themselves: a `yes` to the controller's hand-off is refused
  server-side.
- **Links in replies.** Markdown links, bare `https://` URLs and `path/to/file` code spans that name an
  existing file (relative to the chat's folder, `file:line` too) are clickable:
  - web (`http`, `https`, `mailto`) opens in the default browser;
  - files and folders inside the home folder open in their app or Finder; anything that could run code
    (apps, scripts, installers, executables) is only selected in Finder;
  - other schemes and paths outside the home folder are not followed.

  A link whose text differs from its target shows the target after it, since replies can quote document
  text.
- **Project folder guard.** The folder must be inside the home folder. These are refused:
  - the home folder itself;
  - hidden folders (`~/.ssh`, `~/.config`, …);
  - `~/Library`, except iCloud Drive.
- **Loopback only.** Every URL is built as `http://127.0.0.1:<port>`; ATS allows only local networking.

## Plugins

AFM Agent is the core and always on. It includes **pdftext**, OnBud's own PDF-text and Vision-OCR
helper, which uses system frameworks only. `make app` builds pdftext into the app, and Backend >
pdftext > *Install* copies it to `~/OnBud/runtime/bin`, where the controller runs it.

Settings > Plugins lists the extras, each with what it is, its status and an on/off switch. A plugin that
is already installed starts out enabled. **Install…** works like this:
1. It explains what will be downloaded.
2. It opens Terminal with the exact commands.
3. Terminal asks `y/N` before running them.

Nothing installs in the background, and macOS asks for your password itself where needed (MacTeX).

| Plugin | Detected by | Install… runs | Adds |
|---|---|---|---|
| **Router model** | Ollaya on 127.0.0.1:11436, `~/OnBud/runtime/ollaya` or `~/.ollaya/models`; the models from `/api/tags` | `scripts/decima-setup.sh install && pull && start` | the **AFM + <router>** model (Decima by default; pick any installed model) |
| **Codex via OpenCode** | `/Applications/OpenCode.app` or the `opencode` CLI; ready once the OpenCode config has the codex agent | OpenCode's official installer | **Send to Codex** on escalations, **Review with Codex** for jobs |
| **Web search (SearXNG)** | `~/OnBud/runtime/searxng` (running: 127.0.0.1:8888) | `scripts/searxng-setup.sh install && start` (AGPL, ~150 MB) | approval-gated web search; without SearXNG it falls back to DuckDuckGo Lite, arXiv and Wikipedia. Queries leave the Mac |
| **LaTeX (MacTeX)** | `/Library/TeX/texbin/latexmk` | `brew install --cask mactex-no-gui` (~6 GB), or the download page | compiling papers and fixing LaTeX errors (citation checks and polishing work without it) |
| **Remote server (SSH · Fresh/TTT)** | `fresh` on the Mac (Homebrew, Cargo) and the servers it can name (`~/OnBud/config/servers.json`, `Host` names in `~/.ssh/config`) | `brew install fresh-editor` (GPL-3.0, a separate program), or the project page; TTT is installed on the server by you | the `server` skill: run experiments on your server after approval, job state and logs, and a terminal window on it (Fresh, TTT, a shell, tmux attach, `tail -F`). SSH keys are never read |
| **Translation languages** | the Translation framework (each language ↔ English) and `~/OnBud/runtime/bin/afm-translate` | a **Download…** button per language (macOS's own download sheet), *Build now* for the translator | offline translation of Korean questions into English search words (always used when available; without the pack only that step is skipped) |

With the web plugin on, the launcher sends `x-onbud-web: on`. The server then leaves the controller's
web search on for that request, still behind the controller's own "search for …?" approval.

**Send to Codex**:
- **Desktop app installed (preferred):** the launcher reads OpenCode's local service address and
  password from `~/.local/state/opencode/service.json`, accepting only a 127.0.0.1 address. It creates a
  new session (agent `codex`, the project folder, the request as first prompt) and brings OpenCode
  forward. If the app is not running, it is launched first.
- **CLI only (OpenCode 2):** the TUI has no `--agent` flag, so the launcher starts the session on the
  `codex` agent through the CLI's background service (`opencode service start` if it is not running; same
  `service.json`, loopback only) and Terminal opens `opencode <folder> --session <id>` on it. If the service
  cannot be reached, Terminal runs `opencode run --agent codex '<request>'` once and shows how to continue.
  Every argument is single-quoted, and the temporary `.command` file is deleted on the next hand-off.
- **Either way,** Codex runs with OpenCode's own edit/command approvals and the security-gate plugin.

The **Backend** window (menu bar > Backend…, or Settings) starts with **Routing**: the controller and the
three model tiers it routes between, each with its setting.

| Tier | Model | Change it here |
|---|---|---|
| Local LLM | Apple's on-device model through apfel (127.0.0.1:11434) | fixed; shows the context window and whether the model is available |
| Decision model | the router plugin's model on Ollaya (127.0.0.1:11436) | plugin on/off, which installed model, use it in the panel; warns when it is not the calibrated version |
| Code LLM (S5) | GitHub Copilot's inline completion through its official language server (`~/OnBud/runtime/copilot-ls`) | **Copilot mode**: `balanced` (default: checkable code → Copilot first, Codex if it fails; contest-style code → Copilot only when the bundled difficulty classifier calls it easy) or `saver` (Copilot first for all checkable code; fewer Codex calls, slower, less accurate); writes only the `copilot_mode:` line of `policies/routing.yaml`, which the controller reloads |
| Frontier LLM | two tiers: **Strong** = OpenCode's `codex`, `codex-handoff` and `codex-solve` agents (default GPT-6.1 Sol: hand-offs, Send to Codex, code the cheap tier could not verify); **Cheap** = `codex-solve-cheap` (default GPT-6.1 Terra: the code skill's first escalation, kept only when a check passes) | per tier, any model OpenCode lists for your signed-in providers, and the effort (variant). The agent names say the role, so a new model is one setting, not a rename |

- **Frontier changes go into the global OpenCode config** (Show diff → Apply; a backup is written next to
  it, and the write is refused if the file changed meanwhile). Only those agents' `model` / `variant` lines
  change; comments and everything else stay. Because the controller hands off with `opencode run --agent
  codex-handoff`, OnBud's routing and OpenCode switch together (restart the OpenCode app if it is open).
- **Other providers (Claude, GitHub Copilot, …):** *Add a provider key…* opens Terminal with `opencode auth
  login`. The key stays in OpenCode (`~/.local/share/opencode/auth.json`); OnBud only lists which
  providers are signed in (`opencode auth list`) and their models (`opencode models`).

**GitHub Copilot** (below Routing):
- **Status** from the controller's `services/frontier/copilot-ls.ts status` (signed-in user, or not installed).
- **Sign in…** runs its `signin`: the app shows GitHub's device code (Copy code) and opens
  github.com/login/device when you click **Open GitHub**; you sign in on GitHub yourself. The status is
  checked again when the flow ends (it waits up to 10 minutes).
- **Quota** (read-only): `gh api /copilot_internal/user`. OnBud uses only inline completion, which is
  unlimited and spends no premium requests; no Copilot chat, CLI or agent calls.
- **Use Copilot for code** sets or removes `ONBUD_COPILOT=off` in the controller's LaunchAgent after you
  confirm, and restarts the controller. Re-running setup turns it back on.
- Answers whose route went through Copilot carry a **Copilot** label.

**Router model (Ollaya) and SearXNG run only when you start them.** Backend shows each one's state with
**Start** / **Stop** (the decision card in Routing has Start too). Start runs the plugin's setup script
(`scripts/decima-setup.sh start`, `scripts/searxng-setup.sh start`: a `tmux -L onbud` session that lasts
until Stop or a restart of the Mac). **Start at login** (off by default) installs a LaunchAgent instead
(`scripts/afm-launchagent.sh install decima|searxng`); Stop then unloads it until the next login. While
SearXNG is stopped, approved web searches use DuckDuckGo Lite, arXiv and Wikipedia; while Ollaya is stopped,
the panel uses AFM Agent.

Below that it shows the AFM Agent services, the controller token's permissions, the local tools the
features rely on, and each plugin's services.

## Skills window

Menu bar › **Skills…** lists the 13 skill packs from `skills/<id>/skill.json`:
- what each does (the manifest's description and two example requests);
- what it may do, as chips: capabilities (read, propose, local jobs, run after approval, network, cloud model,
  write new files), its lane (contained / wide) and what leaves the Mac (nothing / an approved query / a
  redacted capsule). Orange marks what reaches outside the answer; every such action still waits for your
  approval in the chat. Private skills carry a **Private** badge;
- the plugins, Backend parts and macOS permissions it uses, with their live state and a button to Settings,
  Backend or Privacy & Security;
- its switch (`core` is always on). Switches write `~/OnBud/config/skills.json` (atomic, mode 600, unknown
  keys kept), which the controller reads on every request. **Calendar & Reminders** is off by default and asks
  before it turns on; macOS then asks once for Calendars and Reminders access for the helper `afm-pim`.
- **Convert** has the largest file it accepts (`options.convert.maxMB`, 500 MB by default).

Settings shows how many skills are on and opens the window. Development: `open OnBud.app --args --open
skills|backend|settings|activity` opens that window at launch, and `--snapshot <png>` also writes it to a PNG
with its frame (no screen-recording permission).

## Chat widget

`make app` also builds `Widget/ChatWidget.swift` into `OnBud.app/Contents/PlugIns/OnBudWidget.appex`, a
WidgetKit extension (medium size; desktop or Notification Center > Edit Widgets > OnBud Chat). It shows
the last question and answer as chat bubbles, and an **Ask OnBud** box. Widgets cannot take typing, so
the box opens the panel (`onbud://ask`).

- The app writes `~/Library/Application Support/OnBud/widget/snapshot.json` (mode 600; the answer
  shortened to 600 characters) after each answer and reloads the widget. New chat or clearing history
  empties it.
- The widget is sandboxed and can read only that folder (a read-only home-relative exception).
- Settings > General can turn the chat off, leaving only the Ask box.
- The extension is ad-hoc signed like the app. macOS may list it only after the app has been opened
  once from its final location.

## OpenCode config link (for the Codex plugin)

Settings > OpenCode config reads the global config (`~/.config/opencode/opencode.jsonc`, else `opencode.json`;
`$XDG_CONFIG_HOME` is honoured). It does nothing when:

- the config is a **symlink to `opencode/opencode.global.jsonc`**, as on the development Mac, or
- the config already has every entry.

Otherwise, **Show diff** shows a unified diff that adds the missing `provider.*`, `agent.*` and `mcp.*`
entries from the repo's `opencode/opencode.global.jsonc`, plus the providers to `enabled_providers` if
the config restricts them. Keys you already have are never changed, with one exception: the MCP entry v0.1.0
added under its old name is replaced by `mcp.onbud` (the diff shows it).

**Back up and merge** works like this:

- It is enabled only after you have seen the diff.
- It copies the file to `opencode.jsonc.afm-spotlight-backup-<time>`, then writes the merge.
- If the file changed after the diff was shown, it refuses to write.
- Comments in the merged file are not kept; they remain in the backup.

## Distribution

- **What ships.** `make app` bundles the controller (`bin`, `services`, `policies`, `scripts`, `opencode`,
  `skills`, and the helper sources `tools/pdftext`, `tools/pdftool`, `tools/pim`, `tools/translate`) in `Contents/Resources/backend`, with a `.onbud-bundled` version
  marker, plus `LICENSE` and `THIRD_PARTY_NOTICES.md`. No third-party code or model is bundled.
- **Setup** (*Set up OnBud…* in the panel, *Run setup…* in Backend) opens Terminal. It copies the
  bundled controller to `~/OnBud/adaptive-coding-agent` (never over a git checkout or a folder without
  the marker), then runs `scripts/setup.sh`: Homebrew, `brew install apfel`, `brew install node` (22.6+)
  and the two LaunchAgents, each only if missing and only after a `y`. When the app carries a newer
  controller than the installed copy, Backend offers *Update…*.
- **Node is found at run time** (`scripts/node-run.sh`: `$ONBUD_NODE`, PATH, Homebrew, Volta, fnm,
  nvm), and the OpenCode config uses `{env:HOME}`, so no path is tied to one Mac.
- **`make dmg`** → `build/OnBud-<version>.dmg` (app + Applications link + LICENSE). **`make release`**
  (`scripts/release.sh`) also writes version and sha256 into `Casks/onbud.rb` at the repository root and
  prints the tag, `gh release create` and tap commands. It publishes nothing itself. The repository is its
  own Homebrew tap (`brew tap p-yi/onbud https://github.com/P-YI/OnBud`, then `brew trust --cask
  p-yi/onbud/onbud` on Homebrew 7+); the cask depends on the
  `apfel` and `node` formulae.
- **Gatekeeper.** The app is signed ad hoc, not notarized. On macOS 15 and later, right-click > Open no
  longer bypasses the block: users click **Open Anyway** in System Settings > Privacy & Security after the
  first attempt, or run `xattr -dr com.apple.quarantine /Applications/OnBud.app`. A Developer ID
  signature plus notarization (paid Apple Developer Program, hardened runtime) removes the step; the
  official homebrew/cask repository requires that too, so OnBud ships from its own tap.
- **Requirements.** macOS 26 or later on Apple silicon, with **Apple Intelligence** turned on, because the
  on-device Foundation Model is only there. The app itself is built for macOS 15+, so on older systems
  it starts and shows the setup screen; setup stops with the reason.
- **License.** MIT (repository `LICENSE`).
- The Command Line Tools ship no SwiftUI macro plugins, so the code uses `ObservableObject` instead of
  `@State`/`@Observable` (both are macros in the current SDK). There is also no XCTest, so the smoke tool
  (`Sources/SpotlightSmoke`) takes the place of unit tests.

## Layout

```
Package.swift                 SwiftPM: SpotlightCore (logic), AFMSpotlight (app), spotlight-smoke
Makefile                      make app / smoke / run / clean
Resources/Info.plist          LSUIElement, bundle id dev.onbud.spotlight
Widget/                       chat widget (WidgetKit extension): ChatWidget.swift, Info.plist, entitlements
Sources/SpotlightCore/        Backend probe, ControllerClient (SSE), JSONC, OpenCodeLink, Plugins, Markdown blocks and links, widget snapshot
Sources/AFMSpotlight/         main (menu bar, panel wiring), MenuBarActivity, HotKey (Carbon), Panel, SpotlightView, SettingsView, TranslationPacks, AppState
Sources/SpotlightSmoke/       smoke checks
```
