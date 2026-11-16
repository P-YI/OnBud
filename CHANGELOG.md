# Changelog

What each OnBud release added, newest first. Full notes per release are in `docs/release-notes-<version>.md`;
downloads are on [GitHub Releases](https://github.com/P-YI/OnBud/releases).

## [0.2.5](docs/release-notes-0.2.5.md) — 2026-11-16 · files, pages and choices
- **Choices instead of guesses:** when a request could mean several things (same-name files, an ambiguous PDF
  page, several LaTeX documents, similar Shortcuts), the panel shows buttons (⌘1…⌘9).
- **Image size targets** ("under 5MB", plus a format), and follow-ups work on the file just made.
- **PDF merges your way:** order, pages picked or left out, a file inserted after a page, page edits on one PDF;
  every page checked against its source.
- **Path questions** answer the absolute path; a bare file name is found in subfolders.

## [0.2.4](docs/release-notes-0.2.4.md) — 2026-11-13 · do, don't describe
- **Mac actions in plain English are carried out**, not explained.
- **More actions:** volume, brightness, lock screen, Wi-Fi, Bluetooth, empty Trash, hidden files, quit an app,
  Finder folders (changes wait for approval).
- **Beyond the list, still local:** about 30 vetted recipes (timers, reminders, notes, music, mail drafts, …);
  otherwise an on-device-written command, checked and approved before it runs.
- Missing Shortcuts open a Gallery search; approving dark mode no longer asks twice.

## [0.2.3](docs/release-notes-0.2.3.md) — 2026-11-11 · work where your path points
- **A path in the request sets the work folder** for every skill (spaces and quotes allowed), inside your home
  folder; hidden folders and secrets are refused, missing paths reported.
- **LaTeX:** the named `.tex` is compiled and only its own references are checked.
- **Translation** picks the marked target language.

## [0.2.2](docs/release-notes-0.2.2.md) — 2026-11-10 · everyday requests
- **System Settings panes open directly** (36 panes).
- **Codex usage** and reset times.
- **Quick answers by code:** time and dates, arithmetic, units, macOS shortcuts.
- General questions from Desktop are answered as chat; faster file-type lists; routing fixes.

## [0.2.1](docs/release-notes-0.2.1.md) — 2026-11-09 · architecture diagram
- An architecture diagram in the README (light and dark).

## [0.2.0](docs/release-notes-0.2.0.md) — 2026-11-09 · OnBud
- **New name, icon and banner:** OpenAFM became OnBud; a v0.1.0 installation is carried over.
- **GitHub Copilot writes code, Codex takes the hard cases:** a ladder Copilot → Codex cheap → Codex strong,
  each answer checked; 66/70 held-out problems at half v0.1.0's cost.
- **13 skill packs with contracts** and a Skills window with switches; replies in nine languages.
- **New skills:** file conversion, Shortcuts, Mac controls, browser tab, calendar and reminders (off by default),
  remote servers over your own SSH.
- Strong / Cheap frontier models picked in Backend > Routing.

## [0.1.0](docs/release-notes-0.1.0.md) — 2026-11-02 · first release (as OpenAFM)
- Spotlight-style launcher (⌥ Space) over Apple's on-device model through apfel, loopback only.
- Documents with OCR, code and git questions, approvals for every command and edit.
- Guided setup; plugins for the router model, Codex via OpenCode, web search, LaTeX and translation.
