# OpenAFM launcher (`apps/spotlight`)

A small, open-source, Spotlight/Raycast-style launcher for local AFM work. Press **⌥ Space**, ask about the
project, approve or deny commands and edits from the panel. It runs without OpenCode, and its setup
installs only what is missing (apfel, Node.js), from their own projects, after asking. Extras come as **plugins**: a router model (Decima by
default), Codex through OpenCode, web search, LaTeX and translation languages. A **chat widget** shows the
last question and answer on the desktop.

| | |
|---|---|
| UI | SwiftUI + AppKit; floating, non-activating panel; menu-bar item (`LSUIElement`, no Dock icon) |
| Hotkey | Carbon `RegisterEventHotKey`, so no Accessibility permission. ⌥ Space by default; ⌃ Space or ⌘ Space in Settings |
| Backend | the OpenAFM controller on `127.0.0.1:11435` (`bin/afm-agent-server.ts`), which uses apfel/AFM on 11434 and, for S3, a router model on Ollaya (11436) |
| Build | SwiftPM with the Command Line Tools only (no Xcode project) |

## Build and run

```sh
cd apps/spotlight
make app      # build/Products.noindex/OpenAFM.app: release build, icon, chat widget, bundled controller, ad-hoc signature
make install  # make app, then copy to /Applications and register only that copy
make run      # build and open with the panel shown
make dmg      # build/OpenAFM-<version>.dmg; make release also writes version and sha256 into Casks/openafm.rb
make smoke    # core checks + live requests through the running controller (make smoke SMOKE_ARGS=--offline to skip them)
```

`make app` runs `scripts/make-icons.swift` (Core Image):
- **App icon:** `Resources/Artwork/AppLogo.png`, with stray specks removed (alpha threshold plus a
  3 px morphological opening), 20% less saturated and 7% darker, cropped to its content and filling ~89%
  of a white rounded square. `iconutil` turns it into `AppIcon.icns`, and the panel shows the same logo.
- **Menu-bar icon:** a black silhouette of `Resources/Artwork/MenuBarLogo.png`, cropped to its content. It
  is a template image, so macOS shows it white on a dark menu bar. **While AFM works** (a panel request,
  or the controller's `/health` reporting `busy` for any client, checked every 2 s) the logo's own colors
  sweep across it from left to right and leave again, until the work is done.

Override the sources with `make app ICON_SRC=… MENUBAR_SRC=…`.

To keep the app, run `make install` (or drag the app from the DMG to `/Applications`). Development builds
live in a `.noindex` folder, so Spotlight and Launchpad show only the installed copy. **Launch at login** in
Settings registers the running copy through `SMAppService`; after moving the app, turn it off and on again.
macOS may ask you to approve it under General > Login Items.

## Panel

- **Top row:** the OpenAFM logo and the "Ask OpenAFM" field. While a request runs, the reply area shows
  the controller's live steps ("Searching the folder…", "Writing a commit message…", …). The controller
  produces each answer in one structured generation and sends it in one piece, so the panel writes it
  out word by word (at most ~0.8 s) instead of dropping it in at once.
- **Attachments** (they appear as chips under the field):
  - drop files onto the panel;
  - paperclip menu > *Paste from clipboard* (copied text, or files copied in Finder) or *Choose files…*;
  - select text or files in any app > Services > **Ask OpenAFM**.

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
  - **Paperclip:** attachments, as above.
  - **Clock:** the last chats (re-open one and continue it), *Activity…* and *Clear history*.
- **Quick actions** (shown while the panel is empty) fit the folder:
  - *Compile the paper* (needs the LaTeX plugin) and *Check citations*, when there is a `.tex` file;
  - *Describe the documents*, for PDF, Word, slides or images;
  - *Summarize changes*, *Commit message*, *Recent commits* and *Local jobs*, in git repositories
    (the first two run the controller's local `change_summary` / `commit_message` skills);
  - *Commands*, always.
- **Each answer** is rendered from Markdown: headings, tables as grids, lists, quotes and code blocks. It
  has Copy and Save-as-Markdown buttons.
- **Links in answers are clickable** (see How it works for what opens).
- **Notifications:** if the panel is closed when an answer arrives, a notification is shown (Settings).
- **History** is kept in `~/Library/Application Support/OpenAFM/history.json` (mode 600, last 50 chats).
  Turning it off in Settings deletes it.
- **Activity window** (menu bar or clock menu) lists:
  - the controller's local jobs (`~/OpenAFM/runtime/jobs`), with *Continue / Apply / Review with Codex /
    Discard* buttons that send the matching chat command, so the usual yes/no approval follows;
  - its background sessions (`tmux -L openafm`).
- **`openafm://ask?q=<text>&folder=<path>`** opens the panel with the question typed in, for Shortcuts,
  Raycast or scripts. It never sends by itself.
- The panel has a fixed width and grows downwards. It closes on Esc or when it loses focus.

## How it works

- **At launch and each time the panel opens**, it probes 127.0.0.1:11434 (apfel `/health`), 11435
  (controller `/health`) and 11436 (Ollaya `/api/tags`). It also looks for `~/OpenAFM`, the token
  `~/OpenAFM/config/apfel.token` and the `dev.openafm.agent` / `dev.openafm.apfel` LaunchAgents.
  - If nothing is installed, the panel shows a setup screen with *Set up OpenAFM…* (see Distribution).
  - If the controller is down, the panel shows the `launchctl kickstart` line instead.
- **Requests** go to `POST /v1/chat/completions` with the bearer token, `stream: true`, and the panel's project
  folder sent as an OpenCode-style `Working directory:` line. The controller only reads folders inside
  `$HOME`, and never `$HOME` itself. Replies stream into the panel.
- **Settings.** The launcher sends `x-openafm-setting: s2|s3`. With that header, the server runs the request
  like the evaluation settings: S2 = rules only, S3 = + router advise, and both with web search and Codex
  off. Without the header the server behaves as before, so OpenCode is unaffected. S3 is used only if
  the router plugin is on and Ollaya is reachable. With S3 the launcher also sends
  `x-openafm-router-model: <name>` for the router model picked in Settings. The thresholds' digest pin
  still applies, so a model other than the calibrated decima:agent is only logged in shadow. As in the
  evaluation, the router advises only on generic routes; skill routes (documents, edits, commands) stay
  with the rules.
- **Approvals.** The controller keeps its own approve/deny flow. In launcher requests, its final stream
  chunk carries `openafm.awaiting`: `command`, `edit`, `apply`, `web`, `job`, `handoff` or `reveal`. The
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

AFM Agent is the core and always on. It includes **pdftext**, OpenAFM's own PDF-text and Vision-OCR
helper, which uses system frameworks only. `make app` builds pdftext into the app, and Backend >
pdftext > *Install* copies it to `~/OpenAFM/runtime/bin`, where the controller runs it.

Settings > Plugins lists the extras, each with what it is, its status and an on/off switch. A plugin that
is already installed starts out enabled. **Install…** works like this:
1. It explains what will be downloaded.
2. It opens Terminal with the exact commands.
3. Terminal asks `y/N` before running them.

Nothing installs in the background, and macOS asks for your password itself where needed (MacTeX).

| Plugin | Detected by | Install… runs | Adds |
|---|---|---|---|
| **Router model** | Ollaya on 127.0.0.1:11436, `~/OpenAFM/runtime/ollaya` or `~/.ollaya/models`; the models from `/api/tags` | `scripts/decima-setup.sh install && pull && start` | the **AFM + <router>** model (Decima by default; pick any installed model) |
| **Codex via OpenCode** | `/Applications/OpenCode.app` or the `opencode` CLI; ready once the OpenCode config has the codex agent | OpenCode's official installer | **Send to Codex** on escalations, **Review with Codex** for jobs |
| **Web search (SearXNG)** | `~/OpenAFM/runtime/searxng` (running: 127.0.0.1:8888) | `scripts/searxng-setup.sh install && start` (AGPL, ~150 MB) | approval-gated web search; without SearXNG it falls back to DuckDuckGo Lite, arXiv and Wikipedia. Queries leave the Mac |
| **LaTeX (MacTeX)** | `/Library/TeX/texbin/latexmk` | `brew install --cask mactex-no-gui` (~6 GB), or the download page | compiling papers and fixing LaTeX errors (citation checks and polishing work without it) |
| **Translation languages** | the Translation framework (each language ↔ English) and `~/OpenAFM/runtime/bin/afm-translate` | a **Download…** button per language (macOS's own download sheet), *Build now* for the translator | offline translation of Korean questions into English search words (always used when available; without the pack only that step is skipped) |

With the web plugin on, the launcher sends `x-openafm-web: on`. The server then leaves the controller's
web search on for that request, still behind the controller's own "search for …?" approval.

**Send to Codex**:
- **Desktop app installed (preferred):** the launcher reads OpenCode's local service address and
  password from `~/.local/state/opencode/service.json`, accepting only a 127.0.0.1 address. It creates a
  new session (agent `codex`, the project folder, the request as first prompt) and brings OpenCode
  forward. If the app is not running, it is launched first.
- **CLI only:** Terminal opens `opencode <folder> --agent codex --prompt '<request>'`. Every argument is
  single-quoted, and the temporary `.command` file is deleted on the next hand-off.
- **Either way,** Codex runs with OpenCode's own edit/command approvals and the security-gate plugin.

The **Backend** window (menu bar > Backend…, or Settings) shows the AFM Agent services, the controller
token's permissions, the local tools the features rely on, and each plugin's services.

## Chat widget

`make app` also builds `Widget/ChatWidget.swift` into `OpenAFM.app/Contents/PlugIns/OpenAFMWidget.appex`, a
WidgetKit extension (medium size; desktop or Notification Center > Edit Widgets > OpenAFM Chat). It shows
the last question and answer as chat bubbles, and an **Ask OpenAFM** box. Widgets cannot take typing, so
the box opens the panel (`openafm://ask`).

- The app writes `~/Library/Application Support/OpenAFM/widget/snapshot.json` (mode 600; the answer
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
the config restricts them. Keys you already have are never changed.

**Back up and merge** works like this:

- It is enabled only after you have seen the diff.
- It copies the file to `opencode.jsonc.afm-spotlight-backup-<time>`, then writes the merge.
- If the file changed after the diff was shown, it refuses to write.
- Comments in the merged file are not kept; they remain in the backup.

## Distribution (v0.1)

- **What ships.** `make app` bundles the controller (`bin`, `services`, `policies`, `scripts`, `opencode`,
  `tools/pdftext`, `tools/translate`) in `Contents/Resources/backend`, with a `.openafm-bundled` version
  marker, plus `LICENSE` and `THIRD_PARTY_NOTICES.md`. No third-party code or model is bundled.
- **Setup** (*Set up OpenAFM…* in the panel, *Run setup…* in Backend) opens Terminal. It copies the
  bundled controller to `~/OpenAFM/adaptive-coding-agent` (never over a git checkout or a folder without
  the marker), then runs `scripts/setup.sh`: Homebrew, `brew install apfel`, `brew install node` (22.6+)
  and the two LaunchAgents, each only if missing and only after a `y`. When the app carries a newer
  controller than the installed copy, Backend offers *Update…*.
- **Node is found at run time** (`scripts/node-run.sh`: `$OPENAFM_NODE`, PATH, Homebrew, Volta, fnm,
  nvm), and the OpenCode config uses `{env:HOME}`, so no path is tied to one Mac.
- **`make dmg`** → `build/OpenAFM-<version>.dmg` (app + Applications link + LICENSE). **`make release`**
  (`scripts/release.sh`) also writes version and sha256 into `Casks/openafm.rb` at the repository root and
  prints the tag, `gh release create` and tap commands. It publishes nothing itself. The repository is its
  own Homebrew tap (`brew tap p-yi/openafm https://github.com/P-YI/OpenAFM`, then `brew trust --cask
  p-yi/openafm/openafm` on Homebrew 7+); the cask depends on the
  `apfel` and `node` formulae.
- **Gatekeeper.** The app is signed ad hoc, not notarized. On macOS 15 and later, right-click > Open no
  longer bypasses the block: users click **Open Anyway** in System Settings > Privacy & Security after the
  first attempt, or run `xattr -dr com.apple.quarantine /Applications/OpenAFM.app`. A Developer ID
  signature plus notarization (paid Apple Developer Program, hardened runtime) removes the step; the
  official homebrew/cask repository requires that too, so OpenAFM ships from its own tap.
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
Resources/Info.plist          LSUIElement, bundle id dev.openafm.spotlight
Widget/                       chat widget (WidgetKit extension): ChatWidget.swift, Info.plist, entitlements
Sources/SpotlightCore/        Backend probe, ControllerClient (SSE), JSONC, OpenCodeLink, Plugins, Markdown blocks and links, widget snapshot
Sources/AFMSpotlight/         main (menu bar, panel wiring), MenuBarActivity, HotKey (Carbon), Panel, SpotlightView, SettingsView, TranslationPacks, AppState
Sources/SpotlightSmoke/       smoke checks
```
